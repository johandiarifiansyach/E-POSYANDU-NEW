begin;

-- Keep the "Baru Diinput" table view on the same Jakarta report-month
-- boundary used by the dashboard aggregate.  The replica function was
-- originally written with a session-time-zone-dependent timestamptz cast;
-- replacing it here makes a child created around midnight UTC land in the
-- same month in both views.  The DO block is intentionally idempotent for
-- rolling deployments where the function may not exist yet.
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
      $needle$c.created_at >= p_measurement_start::timestamptz and c.created_at < (p_measurement_end + interval '1 day')::timestamptz$needle$,
      $replacement$timezone('Asia/Jakarta', c.created_at) >= p_measurement_start and timezone('Asia/Jakarta', c.created_at) < (p_measurement_end + 1)$replacement$
    );
    if corrected_definition = function_definition then
      corrected_definition := replace(
        function_definition,
        $needle$c.created_at >= p_as_of::timestamptz and c.created_at < (p_as_of + interval '1 month')::timestamptz$needle$,
        $replacement$timezone('Asia/Jakarta', c.created_at) >= p_measurement_start and timezone('Asia/Jakarta', c.created_at) < (p_measurement_end + 1)$replacement$
      );
    end if;
    -- A few early installs used the same measurement-period predicate
    -- without explicit timestamptz casts.  Rewrite that form as well so a
    -- rolling deployment still gets a deterministic Jakarta month boundary.
    if corrected_definition = function_definition then
      corrected_definition := replace(
        function_definition,
        $needle$c.created_at >= p_measurement_start and c.created_at < (p_measurement_end + interval '1 day')$needle$,
        $replacement$timezone('Asia/Jakarta', c.created_at) >= p_measurement_start and timezone('Asia/Jakarta', c.created_at) < (p_measurement_end + 1)$replacement$
      );
    end if;
    if corrected_definition <> function_definition then
      execute corrected_definition;
    end if;
  end if;
end
$$;

-- Dashboard and child tables must read one projection.  The Python worker is
-- still the sole authority for clinical fields; this function only performs
-- cheap scope/period aggregation over the persisted measurement_analysis
-- rows.  Keeping it separate from the historical dashboard snapshot also
-- prevents a stale snapshot from hiding a newly committed child or measure.
create or replace function public.eposyandu_dashboard_materialized_stats(
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  p_age_group text,
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
  with scoped_children as materialized (
    select c.*
    from public.children c
    where c.deleted_at is null
      and public.eposyandu_scope_match(
        c.village, c.posyandu,
        nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
        p_role, p_scope_village, p_scope_posyandu
      )
  ),
  active_children as materialized (
    select c.*,
      (timezone('Asia/Jakarta', c.created_at) >= p_month_start
       and timezone('Asia/Jakarta', c.created_at) < (p_month_start + interval '1 month')) as created_in_month
    from scoped_children c
    where public.eposyandu_age_group_match(
      coalesce(nullif(trim(p_age_group), ''), '0-59'),
      c.birth_date, p_month_end, c.gestational_age_weeks
    )
  ),
  latest_current as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      m.id as measurement_id,
      m.weight_kg,
      a.measurement_id as analysis_id,
      a.weight_gain_status,
      a.bbu_status,
      a.tbu_status,
      a.bbtb_status,
      a.imtu_status
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
  rows as materialized (
    select c.id, c.created_in_month,
      l.measurement_id, l.weight_kg, l.analysis_id, l.weight_gain_status,
      l.bbu_status, l.tbu_status, l.bbtb_status, l.imtu_status,
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
      count(*) filter (where weight_kg > 0 and not measured_previous_month)::integer as o,
      count(*) filter (where weight_kg > 0 and bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))::integer as underweight,
      count(*) filter (where weight_kg > 0 and tbu_status in ('Sangat Pendek', 'Pendek'))::integer as stunting,
      count(*) filter (where weight_kg > 0 and bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))::integer as wasting,
      count(*) filter (where weight_kg > 0 and measurement_id is not null
        and analysis_id is null)::integer as analysis_pending
    from rows
  ),
  asi_children as materialized (
    select c.id, c.birth_date
    from scoped_children c
    where public.eposyandu_age_months(c.birth_date, p_month_end) = 6
  ),
  asi_latest as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as child_id,
      a.exclusive_breastfeeding_status
    from public.measurements m
    join asi_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    left join public.measurement_analysis a on a.measurement_id = m.id
    where m.measurement_date >= c.birth_date
      and m.measurement_date <= p_month_end
      and public.eposyandu_age_months(c.birth_date, m.measurement_date) between 0 and 6
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ),
  asi_counts as (
    select count(*)::integer as target,
      count(*) filter (where a.exclusive_breastfeeding_status = 'Ya')::integer as exclusive
    from asi_children c
    left join asi_latest a on a.child_id = c.id
  )
  select jsonb_build_object(
    'S', c.s,
    'D', c.d,
    'N', c.n,
    'T', c.t,
    'B', c.b,
    'O', c.o,
    'asiEksklusif', a.exclusive,
    'asiTarget', a.target,
    'underweight', c.underweight,
    'stunting', c.stunting,
    'wasting', c.wasting,
    'analysisPending', c.analysis_pending > 0,
    'analysisPendingCount', c.analysis_pending,
    'perD', case when c.s = 0 then '0' else round(c.d::numeric * 100 / c.s, 1)::text end,
    'perN', case when c.d = 0 then '0' else round(c.n::numeric * 100 / c.d, 1)::text end,
    'perT', case when c.d = 0 then '0' else round(c.t::numeric * 100 / c.d, 1)::text end,
    'perAsiEksklusif', case when a.target = 0 then '0' else round(a.exclusive::numeric * 100 / a.target, 1)::text end,
    'perUnderweight', case when c.d = 0 then '0' else round(c.underweight::numeric * 100 / c.d, 1)::text end,
    'perStunting', case when c.d = 0 then '0' else round(c.stunting::numeric * 100 / c.d, 1)::text end,
    'perWasting', case when c.d = 0 then '0' else round(c.wasting::numeric * 100 / c.d, 1)::text end,
    'calculator', 'python-materialized-analysis',
    'analytics', 'postgresql-read-python-write-v2',
    'ageGroup', coalesce(nullif(trim(p_age_group), ''), '0-59')
  )
  from counts c cross join asi_counts a;
$$;

revoke all on function public.eposyandu_dashboard_materialized_stats(
  date, date, date, date, text, text, text, text, text, text
) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.eposyandu_dashboard_materialized_stats(date,date,date,date,text,text,text,text,text,text) to authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_dashboard_materialized_stats(date,date,date,date,text,text,text,text,text,text) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'eposyandu_api') then
    execute 'grant execute on function public.eposyandu_dashboard_materialized_stats(date,date,date,date,text,text,text,text,text,text) to eposyandu_api';
  end if;
end;
$$;

insert into public.schema_migrations(version, description)
values ('051', 'age-aware dashboard counts from Python materialized analysis')
on conflict (version) do nothing;

commit;
