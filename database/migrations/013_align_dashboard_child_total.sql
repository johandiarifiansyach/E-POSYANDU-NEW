begin;

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
      ((c.created_at at time zone 'Asia/Jakarta') >= p_month_start and (c.created_at at time zone 'Asia/Jakarta') < (p_month_start + interval '1 month')) as created_in_month,
      exists (
        select 1 from public.measurements previous_measurement
        where previous_measurement.child_id = c.id
          and previous_measurement.measurement_date between p_previous_month_start and p_previous_month_end
      ) as measured_previous_month
    from public.children c
    where c.deleted_at is null
      and c.birth_date <= p_month_end
      and c.birth_date > (p_month_end - interval '60 months')::date
      and public.eposyandu_scope_match(c.village, c.posyandu, p_village, p_posyandu, p_role, p_scope_village, p_scope_posyandu)
  ), latest_current_measurements as (
    select distinct on (m.child_id)
      m.child_id, m.measurement_date, m.weight_kg::double precision as weight_kg,
      m.height_cm::double precision as height_cm, m.measurement_method, m.weight_gain_status,
      m.exclusive_breastfeeding
    from public.measurements m
    join active_children c on c.id = m.child_id
    where m.measurement_date between p_month_start and p_month_end
    order by m.child_id, m.measurement_date desc, m.created_at desc
  ), calculated as (
    select c.*, m.measurement_date, m.weight_kg, m.height_cm, m.measurement_method,
      m.weight_gain_status, m.exclusive_breastfeeding,
      public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)) as age_in_months,
      public.eposyandu_growth_status(m.weight_kg, 'BBU', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)), c.sex, null, m.measurement_method) as bbu_status,
      public.eposyandu_growth_status(m.height_cm, 'TBU', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)), c.sex, null, m.measurement_method) as tbu_status,
      public.eposyandu_growth_status(m.weight_kg, 'BBTB', public.eposyandu_age_months(c.birth_date, coalesce(m.measurement_date, p_month_end)), c.sex, m.height_cm, m.measurement_method) as bbtb_status
    from active_children c
    left join latest_current_measurements m on m.child_id = c.id
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
  ) from counts
$$;

insert into public.schema_migrations (version, description)
values ('013', 'align dashboard child total with child list month end')
on conflict (version) do nothing;

commit;
