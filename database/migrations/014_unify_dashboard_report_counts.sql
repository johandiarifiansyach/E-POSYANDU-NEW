begin;

create index if not exists idx_children_active_location_birth
  on public.children (village, posyandu, birth_date)
  where deleted_at is null;

create index if not exists idx_measurements_legacy_child_date
  on public.measurements (legacy_child_id, measurement_date desc, created_at desc);

create or replace function public.eposyandu_exclusive_breastfeeding_page(
  p_measurement_start date,
  p_measurement_end date,
  p_age_group text,
  p_page integer,
  p_size integer,
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  with active_children as (
    select c.id, c.name, c.national_id, c.has_national_id, c.birth_date, c.village, c.posyandu
    from public.children c
    where c.deleted_at is null
      and c.birth_date <= p_measurement_end
      and c.birth_date > (p_measurement_end - interval '60 months')::date
      and public.eposyandu_scope_match(
        c.village, c.posyandu, p_village, p_posyandu,
        p_role, p_scope_village, p_scope_posyandu
      )
  ), latest_measurements as (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as linked_child_id,
      m.measurement_date, m.exclusive_breastfeeding, m.created_at
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_measurement_start and p_measurement_end
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ), scoped as (
    select c.*, l.measurement_date,
      public.eposyandu_age_months(c.birth_date, l.measurement_date) as age_in_months
    from active_children c
    join latest_measurements l on l.linked_child_id = c.id
    where l.exclusive_breastfeeding = 'Ya'
      and (
        (p_age_group = '0-5' and public.eposyandu_age_months(c.birth_date, l.measurement_date) between 0 and 5)
        or (p_age_group = '6' and public.eposyandu_age_months(c.birth_date, l.measurement_date) = 6)
      )
  ), paged as (
    select *
    from scoped
    order by lower(name), id
    limit greatest(1, least(p_size, 50))
    offset greatest(0, p_page - 1) * greatest(1, least(p_size, 50))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'data', jsonb_build_object(
        'nama', name, 'nik', national_id, 'hasNIK', has_national_id,
        'tglLahir', birth_date, 'desa', village, 'posyandu', posyandu,
        'tglUkur', measurement_date, 'ageInMonths', age_in_months
      )
    )
      order by lower(name), id
    ) from paged), '[]'::jsonb),
    'total', (select count(*) from scoped)
  )
$$;

create or replace function public.eposyandu_problem_children_page(
  p_month_start date,
  p_month_end date,
  p_problem text,
  p_page integer,
  p_size integer,
  p_search text default null,
  p_sort text default 'recent',
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  with active_children as (
    select c.id, c.name, c.national_id, c.has_national_id, c.birth_date, c.sex,
      c.parent_name, c.village, c.posyandu, c.created_at, c.updated_at, c.version
    from public.children c
    where c.deleted_at is null
      and c.birth_date <= p_month_end
      and c.birth_date > (p_month_end - interval '60 months')::date
      and public.eposyandu_scope_match(
        c.village, c.posyandu, p_village, p_posyandu,
        p_role, p_scope_village, p_scope_posyandu
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or c.name ilike '%' || trim(p_search) || '%'
        or c.national_id ilike '%' || trim(p_search) || '%'
      )
  ), latest_current_measurements as (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as linked_child_id,
      m.id as measurement_id, m.measurement_date,
      m.weight_kg::double precision as weight_kg,
      m.height_cm::double precision as height_cm,
      m.head_circumference_cm::double precision as head_circumference_cm,
      m.mid_upper_arm_circumference_cm::double precision as mid_upper_arm_circumference_cm,
      m.measurement_method, m.weight_gain_status, m.age_in_months,
      m.created_at as measurement_created_at, m.updated_at as measurement_updated_at,
      m.version as measurement_version
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_month_start and p_month_end
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ), calculated as (
    select c.*, m.*,
      public.eposyandu_age_months(c.birth_date, m.measurement_date) as calculated_age_months,
      public.eposyandu_growth_status(
        m.weight_kg, 'BBU', public.eposyandu_age_months(c.birth_date, m.measurement_date),
        c.sex, null, m.measurement_method
      ) as bbu_status,
      public.eposyandu_growth_status(
        m.height_cm, 'TBU', public.eposyandu_age_months(c.birth_date, m.measurement_date),
        c.sex, null, m.measurement_method
      ) as tbu_status,
      public.eposyandu_growth_status(
        m.weight_kg, 'BBTB', public.eposyandu_age_months(c.birth_date, m.measurement_date),
        c.sex, m.height_cm, m.measurement_method
      ) as bbtb_status
    from active_children c
    join latest_current_measurements m on m.linked_child_id = c.id
  ), scoped as (
    select *
    from calculated
    where weight_kg > 0
      and case p_problem
        when 'problem_underweight' then bbu_status in ('Berat Sangat Kurang', 'Berat Kurang')
        when 'problem_stunting' then tbu_status in ('Sangat Pendek', 'Pendek')
        when 'problem_wasting' then bbtb_status in ('Gizi Buruk', 'Gizi Kurang')
        when 'problem_tidak_naik' then weight_gain_status = 'T'
        else false
      end
  ), ordered as (
    select scoped.*,
      row_number() over (
        order by
          case when p_sort = 'name_asc' then lower(name) end asc nulls last,
          case when p_sort = 'name_desc' then lower(name) end desc nulls last,
          case when p_sort = 'oldest_input' then created_at end asc nulls last,
          case when p_sort = 'recent' then created_at end desc nulls last,
          case when p_sort = 'age_oldest' then birth_date end asc nulls last,
          case when p_sort = 'age_youngest' then birth_date end desc nulls last,
          lower(name), id
      ) as page_order
    from scoped
  ), paged as (
    select *
    from ordered
    order by page_order
    limit greatest(1, least(p_size, 50))
    offset greatest(0, p_page - 1) * greatest(1, least(p_size, 50))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'data', jsonb_build_object(
        'nama', name, 'nik', national_id, 'hasNIK', has_national_id,
        'tglLahir', birth_date, 'jk', sex, 'namaOrtu', parent_name,
        'desa', village, 'posyandu', posyandu,
        'createdAt', created_at, 'updatedAt', updated_at, 'version', version
      )
    )
      order by page_order
    ) from paged), '[]'::jsonb),
    'measurements', coalesce((select jsonb_agg(jsonb_build_object(
      'id', measurement_id,
      'data', jsonb_build_object(
        'childId', id, 'childName', name, 'desa', village, 'posyandu', posyandu,
        'tglUkur', measurement_date, 'bb', weight_kg, 'tb', height_cm,
        'lk', head_circumference_cm, 'lila', mid_upper_arm_circumference_cm,
        'caraUkur', measurement_method, 'statusNaik', weight_gain_status,
        'ageInMonths', calculated_age_months,
        'createdAt', measurement_created_at, 'updatedAt', measurement_updated_at,
        'version', measurement_version
      )
    )
      order by page_order
    ) from paged), '[]'::jsonb),
    'mpasiLogs', '[]'::jsonb,
    'total', (select count(*) from scoped)
  )
$$;

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
set search_path = public
as $$
  with active_children as (
    select c.id, c.birth_date, c.sex,
      ((c.created_at at time zone 'Asia/Jakarta') >= p_month_start
        and (c.created_at at time zone 'Asia/Jakarta') < (p_month_start + interval '1 month')) as created_in_month,
      exists (
        select 1
        from public.measurements previous_measurement
        where coalesce(previous_measurement.child_id, nullif(previous_measurement.legacy_child_id, '')) = c.id
          and previous_measurement.measurement_date between p_previous_month_start and p_previous_month_end
      ) as measured_previous_month
    from public.children c
    where c.deleted_at is null
      and c.birth_date <= p_month_end
      and c.birth_date > (p_month_end - interval '60 months')::date
      and public.eposyandu_scope_match(
        c.village, c.posyandu, p_village, p_posyandu,
        p_role, p_scope_village, p_scope_posyandu
      )
  ), latest_current_measurements as (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as linked_child_id,
      m.measurement_date, m.weight_kg::double precision as weight_kg,
      m.height_cm::double precision as height_cm, m.measurement_method,
      m.weight_gain_status, m.exclusive_breastfeeding
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_month_start and p_month_end
    order by coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc, m.created_at desc, m.id desc
  ), calculated as (
    select c.*, m.measurement_date, m.weight_kg, m.height_cm, m.measurement_method,
      m.weight_gain_status, m.exclusive_breastfeeding,
      public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)) as age_in_months,
      public.eposyandu_growth_status(
        m.weight_kg, 'BBU', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)),
        c.sex, null, m.measurement_method
      ) as bbu_status,
      public.eposyandu_growth_status(
        m.height_cm, 'TBU', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)),
        c.sex, null, m.measurement_method
      ) as tbu_status,
      public.eposyandu_growth_status(
        m.weight_kg, 'BBTB', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)),
        c.sex, m.height_cm, m.measurement_method
      ) as bbtb_status
    from active_children c
    left join latest_current_measurements m on m.linked_child_id = c.id
  ), counts as (
    select
      count(*)::integer as s,
      count(*) filter (where weight_kg > 0)::integer as d,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'N')::integer as n,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'T')::integer as t,
      count(*) filter (where created_in_month)::integer as b,
      count(*) filter (where not measured_previous_month)::integer as o,
      count(*) filter (where age_in_months = 6 and exclusive_breastfeeding = 'Ya')::integer as asi_eksklusif,
      count(*) filter (where age_in_months = 6)::integer as asi_target,
      count(*) filter (where weight_kg > 0 and bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))::integer as underweight,
      count(*) filter (where weight_kg > 0 and tbu_status in ('Sangat Pendek', 'Pendek'))::integer as stunting,
      count(*) filter (where weight_kg > 0 and bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))::integer as wasting
    from calculated
  )
  select jsonb_build_object(
    'S', s, 'D', d, 'N', n, 'T', t, 'B', b, 'O', o,
    'asiEksklusif', asi_eksklusif, 'asiTarget', asi_target,
    'underweight', underweight, 'stunting', stunting, 'wasting', wasting,
    'perD', case when s = 0 then '0' else round(d::numeric * 100 / s, 1)::text end,
    'perN', case when d = 0 then '0' else round(n::numeric * 100 / d, 1)::text end,
    'perT', case when d = 0 then '0' else round(t::numeric * 100 / d, 1)::text end,
    'perAsiEksklusif', case when asi_target = 0 then '0' else round(asi_eksklusif::numeric * 100 / asi_target, 1)::text end,
    'perUnderweight', case when d = 0 then '0' else round(underweight::numeric * 100 / d, 1)::text end,
    'perStunting', case when d = 0 then '0' else round(stunting::numeric * 100 / d, 1)::text end,
    'perWasting', case when d = 0 then '0' else round(wasting::numeric * 100 / d, 1)::text end
  )
  from counts
$$;

revoke all on function public.eposyandu_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text, text, text, text) from public;
revoke all on function public.eposyandu_problem_children_page(date, date, text, integer, integer, text, text, text, text, text, text, text) from public;
revoke all on function public.eposyandu_dashboard_stats(date, date, date, date, text, text, text, text, text) from public;

grant execute on function public.eposyandu_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text, text, text, text) to service_role;
grant execute on function public.eposyandu_problem_children_page(date, date, text, integer, integer, text, text, text, text, text, text, text) to service_role;
grant execute on function public.eposyandu_dashboard_stats(date, date, date, date, text, text, text, text, text) to service_role;

insert into public.schema_migrations (version, description)
values ('014', 'unify dashboard, child report, nutrition problem, and breastfeeding counts')
on conflict (version) do nothing;

commit;
