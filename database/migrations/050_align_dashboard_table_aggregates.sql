begin;

-- The table and dashboard must select the same row for a child.  In
-- particular, a child can have two measurements on one day; created_at and
-- id are the deterministic tie breakers used by the materialized table.
-- Recent input is also bounded by the selected report month (measurement
-- start/end), not by the as-of day, which is the end of that month.
do $$
declare
  function_definition text;
  corrected_definition text;
begin
  select pg_get_functiondef(p.oid)
    into function_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'eposyandu_replica_children_page'
    and pg_get_function_identity_arguments(p.oid) =
      'p_as_of date, p_measurement_start date, p_measurement_end date, p_page integer, p_size integer, p_sort text, p_view text, p_search text, p_village text, p_posyandu text, p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text';

  if function_definition is not null then
    corrected_definition := replace(
      function_definition,
      $needle$c.created_at >= p_as_of::timestamptz and c.created_at < (p_as_of + interval '1 month')::timestamptz$needle$,
      $replacement$c.created_at >= p_measurement_start::timestamptz and c.created_at < (p_measurement_end + interval '1 day')::timestamptz$replacement$
    );
    if corrected_definition = function_definition then
      corrected_definition := replace(
        function_definition,
        $needle$c.created_at >= p_as_of and c.created_at < (p_as_of + interval '1 month')$needle$,
        $replacement$c.created_at >= p_measurement_start and c.created_at < (p_measurement_end + interval '1 day')$replacement$
      );
    end if;
    if corrected_definition <> function_definition then
      execute corrected_definition;
    end if;
  end if;
end
$$;

-- Keep the legacy GET/GraphQL dashboard endpoint on the same persisted
-- analysis projection as the React POST endpoint.  This function performs
-- only scope, period, and count aggregation; all clinical fields in
-- measurement_analysis were produced by Python.
create or replace function public.eposyandu_dashboard_stats(
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with active_children as materialized (
    select c.id, c.birth_date,
      (timezone('Asia/Jakarta', c.created_at) >= p_month_start
       and timezone('Asia/Jakarta', c.created_at) < (p_month_start + interval '1 month')) as created_in_month
    from public.children c
    where c.deleted_at is null
      and public.eposyandu_age_group_match('0-59', c.birth_date, p_month_end, c.gestational_age_weeks)
      and public.eposyandu_scope_match(
        c.village, c.posyandu, nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
        p_role, p_scope_village, p_scope_posyandu
      )
  ),
  latest_current as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      m.id as measurement_id, m.measurement_date, m.weight_kg,
      m.exclusive_breastfeeding, a.weight_gain_status,
      a.bbu_status, a.tbu_status, a.bbtb_status
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    left join public.measurement_analysis a on a.measurement_id = m.id
    where m.measurement_date between p_month_start and p_month_end
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ),
  previous_children as materialized (
    select distinct coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_previous_month_start and p_previous_month_end
  ),
  asi_latest as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      a.exclusive_breastfeeding_status
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    left join public.measurement_analysis a on a.measurement_id = m.id
    where m.measurement_date <= p_month_end
      and public.eposyandu_age_months(c.birth_date, m.measurement_date) between 0 and 6
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ),
  rows as materialized (
    select c.*, l.measurement_id, l.weight_kg, l.weight_gain_status,
      l.bbu_status, l.tbu_status, l.bbtb_status,
      (p.child_id is not null) as measured_previous_month
    from active_children c
    left join latest_current l on l.child_id = c.id
    left join previous_children p on p.child_id = c.id
  ),
  counts as (
    select
      count(*)::integer as s,
      count(*) filter (where weight_kg > 0)::integer as d,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'N')::integer as n,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'T')::integer as t,
      count(*) filter (where created_in_month)::integer as b,
      -- O is a current-row status. Children without a current valid weight
      -- are not present in the table's Kenaikan column.
      count(*) filter (where weight_kg > 0 and not measured_previous_month)::integer as o,
      count(*) filter (where bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))::integer as underweight,
      count(*) filter (where tbu_status in ('Sangat Pendek', 'Pendek'))::integer as stunting,
      count(*) filter (where bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))::integer as wasting
    from rows
  ),
  asi_counts as (
    select
      count(*) filter (where public.eposyandu_age_months(c.birth_date, p_month_end) = 6)::integer as target,
      count(*) filter (
        where public.eposyandu_age_months(c.birth_date, p_month_end) = 6
          and a.exclusive_breastfeeding_status = 'Ya'
      )::integer as exclusive
    from active_children c
    left join asi_latest a on a.child_id = c.id
  )
  select jsonb_build_object(
    'S', c.s, 'D', c.d, 'N', c.n, 'T', c.t, 'B', c.b, 'O', c.o,
    'asiEksklusif', a.exclusive, 'asiTarget', a.target,
    'underweight', c.underweight, 'stunting', c.stunting, 'wasting', c.wasting,
    'perD', case when c.s = 0 then '0' else round(c.d::numeric * 100 / c.s, 1)::text end,
    'perN', case when c.d = 0 then '0' else round(c.n::numeric * 100 / c.d, 1)::text end,
    'perT', case when c.d = 0 then '0' else round(c.t::numeric * 100 / c.d, 1)::text end,
    'perAsiEksklusif', case when a.target = 0 then '0' else round(a.exclusive::numeric * 100 / a.target, 1)::text end,
    'perUnderweight', case when c.d = 0 then '0' else round(c.underweight::numeric * 100 / c.d, 1)::text end,
    'perStunting', case when c.d = 0 then '0' else round(c.stunting::numeric * 100 / c.d, 1)::text end,
    'perWasting', case when c.d = 0 then '0' else round(c.wasting::numeric * 100 / c.d, 1)::text end,
    'calculator', 'python-materialized-analysis',
    'analytics', 'postgresql-read-python-write-v2'
  )
  from counts c cross join asi_counts a
$$;

revoke all on function public.eposyandu_dashboard_stats(date, date, date, date, text, text, text, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.eposyandu_dashboard_stats(date,date,date,date,text,text,text,text,text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_dashboard_stats(date,date,date,date,text,text,text,text,text) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'eposyandu_api') then
    execute 'grant execute on function public.eposyandu_dashboard_stats(date,date,date,date,text,text,text,text,text) to eposyandu_api';
  end if;
end
$$;

insert into public.schema_migrations(version, description)
values ('050', 'align dashboard aggregates with materialized child table and report month')
on conflict (version) do nothing;

commit;
