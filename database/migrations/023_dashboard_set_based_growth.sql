begin;

-- Keep the dashboard scope and previous-month check index-friendly. The
-- existing location index remains useful for role and wilayah filtering;
-- this partial index avoids visiting deleted children during the report.
create index if not exists idx_children_dashboard_scope
  on public.children (village, posyandu, birth_date, id)
  where deleted_at is null;

analyze public.children;
analyze public.measurements;
analyze public.eposyandu_growth_lms_points;

-- Classify the current measurements in one set-based query. Calling the
-- PL/pgSQL status function three times per child caused the full dashboard
-- report to exceed the edge proxy timeout on a busy database.
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
  with previous_measured_children as materialized (
    select distinct
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as linked_child_id
    from public.measurements m
    where m.measurement_date between p_previous_month_start and p_previous_month_end
      and coalesce(m.child_id, nullif(m.legacy_child_id, '')) is not null
  ), active_children as materialized (
    select
      c.id,
      c.birth_date,
      c.sex,
      (
        (c.created_at at time zone 'Asia/Jakarta') >= p_month_start
        and (c.created_at at time zone 'Asia/Jakarta') < (p_month_start + interval '1 month')
      ) as created_in_month,
      pm.linked_child_id is not null as measured_previous_month
    from public.children c
    left join previous_measured_children pm on pm.linked_child_id = c.id
    where c.deleted_at is null
      and c.birth_date <= p_month_end
      and c.birth_date > (p_month_end - interval '60 months')::date
      and (p_village is null or c.village = p_village)
      and (p_posyandu is null or c.posyandu = p_posyandu)
      and (p_role = 'Ahli Gizi' or c.village = p_scope_village)
      and (p_role <> 'Kader Posyandu' or c.posyandu = p_scope_posyandu)
  ), latest_current_measurements as materialized (
    select distinct on (coalesce(m.child_id, nullif(m.legacy_child_id, '')))
      coalesce(m.child_id, nullif(m.legacy_child_id, '')) as linked_child_id,
      m.measurement_date,
      m.weight_kg::double precision as weight_kg,
      m.height_cm::double precision as height_cm,
      m.measurement_method,
      m.weight_gain_status,
      m.exclusive_breastfeeding
    from public.measurements m
    join active_children c
      on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_month_start and p_month_end
    order by
      coalesce(m.child_id, nullif(m.legacy_child_id, '')),
      m.measurement_date desc,
      m.created_at desc,
      m.id desc
  ), current_base as materialized (
    select
      c.id,
      c.birth_date,
      c.sex,
      c.created_in_month,
      c.measured_previous_month,
      m.measurement_date,
      m.weight_kg,
      m.height_cm,
      m.measurement_method,
      m.weight_gain_status,
      m.exclusive_breastfeeding,
      public.eposyandu_age_months(
        c.birth_date,
        coalesce(m.measurement_date, p_month_end)
      ) as age_in_months
    from active_children c
    left join latest_current_measurements m on m.linked_child_id = c.id
  ), basic_counts as (
    select
      count(*)::integer as s,
      count(*) filter (where created_in_month)::integer as b,
      count(*) filter (where not measured_previous_month)::integer as o
    from active_children
  ), measurement_counts as (
    select
      count(*) filter (where weight_kg > 0)::integer as d,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'N')::integer as n,
      count(*) filter (where weight_kg > 0 and weight_gain_status = 'T')::integer as t,
      count(*) filter (where age_in_months = 6 and exclusive_breastfeeding = 'Ya')::integer as asi_eksklusif,
      count(*) filter (where age_in_months = 6)::integer as asi_target
    from current_base
  ), adjusted as materialized (
    select
      b.*,
      case
        when b.height_cm is null or b.height_cm <= 0 then null
        when b.age_in_months <= 24 and b.measurement_method = 'Berdiri' then b.height_cm + 0.7
        when b.age_in_months > 24 and b.measurement_method = 'Terlentang' then b.height_cm - 0.7
        else b.height_cm
      end as adjusted_height
    from current_base b
  ), scored as materialized (
    select
      a.*,
      bbu.l as bbu_l,
      bbu.m as bbu_m,
      bbu.s as bbu_s,
      tbu.l as tbu_l,
      tbu.m as tbu_m,
      tbu.s as tbu_s,
      bbtb.l as bbtb_l,
      bbtb.m as bbtb_m,
      bbtb.s as bbtb_s
    from adjusted a
    left join public.eposyandu_growth_lms_points bbu
      on bbu.metric = 'weight_for_age'
      and bbu.sex = a.sex
      and bbu.sample_index = a.age_in_months
    left join public.eposyandu_growth_lms_points tbu
      on tbu.metric = 'length_height_for_age'
      and tbu.sex = a.sex
      and tbu.sample_index = a.age_in_months
    left join public.eposyandu_growth_lms_points bbtb
      on bbtb.metric = case
        when a.age_in_months <= 24 then 'weight_for_length'
        else 'weight_for_height'
      end
      and bbtb.sex = a.sex
      and bbtb.sample_index = case
        when a.adjusted_height is null or a.adjusted_height <= 0 then null
        when a.age_in_months <= 24 then round((a.adjusted_height - 45)::numeric * 2)::integer
        else round((a.adjusted_height - 65)::numeric * 2)::integer
      end
  ), zscores as materialized (
    select
      s.*,
      case
        when s.weight_kg > 0 and s.bbu_m > 0 and s.bbu_s > 0 then
          case
            when s.bbu_l = 0 then ln(s.weight_kg / s.bbu_m) / s.bbu_s
            else (power(s.weight_kg / s.bbu_m, s.bbu_l) - 1) / (s.bbu_l * s.bbu_s)
          end
      end as bbu_score,
      case
        when s.adjusted_height > 0 and s.tbu_m > 0 and s.tbu_s > 0 then
          case
            when s.tbu_l = 0 then ln(s.adjusted_height / s.tbu_m) / s.tbu_s
            else (power(s.adjusted_height / s.tbu_m, s.tbu_l) - 1) / (s.tbu_l * s.tbu_s)
          end
      end as tbu_score,
      case
        when s.weight_kg > 0 and s.bbtb_m > 0 and s.bbtb_s > 0 then
          case
            when s.bbtb_l = 0 then ln(s.weight_kg / s.bbtb_m) / s.bbtb_s
            else (power(s.weight_kg / s.bbtb_m, s.bbtb_l) - 1) / (s.bbtb_l * s.bbtb_s)
          end
      end as bbtb_score
    from scored s
  ), classified as materialized (
    select
      z.*,
      case
        when z.bbu_score is null then '-'
        when z.bbu_score < -3 then 'Berat Sangat Kurang'
        when z.bbu_score < -2 then 'Berat Kurang'
        when z.bbu_score <= 1 then 'Berat Normal'
        else 'Risiko Berat Lebih'
      end as bbu_status,
      case
        when z.tbu_score is null then '-'
        when z.tbu_score < -3 then 'Sangat Pendek'
        when z.tbu_score < -2 then 'Pendek'
        when z.tbu_score <= 3 then 'Normal'
        else 'Tinggi'
      end as tbu_status,
      case
        when z.bbtb_score is null then '-'
        when z.bbtb_score < -3 then 'Gizi Buruk'
        when z.bbtb_score < -2 then 'Gizi Kurang'
        when z.bbtb_score <= 1 then 'Gizi Baik'
        when z.bbtb_score <= 2 then 'Risiko Gizi Lebih'
        when z.bbtb_score <= 3 then 'Gizi Lebih'
        else 'Obesitas'
      end as bbtb_status
    from zscores z
    where z.weight_kg > 0
  ), nutrition_counts as (
    select
      count(*) filter (where bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))::integer as underweight,
      count(*) filter (where tbu_status in ('Sangat Pendek', 'Pendek'))::integer as stunting,
      count(*) filter (where bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))::integer as wasting
    from classified
  )
  select jsonb_build_object(
    'S', bc.s,
    'D', mc.d,
    'N', mc.n,
    'T', mc.t,
    'B', bc.b,
    'O', bc.o,
    'asiEksklusif', mc.asi_eksklusif,
    'asiTarget', mc.asi_target,
    'underweight', nc.underweight,
    'stunting', nc.stunting,
    'wasting', nc.wasting,
    'perD', case when bc.s = 0 then '0' else round(mc.d::numeric * 100 / bc.s, 1)::text end,
    'perN', case when mc.d = 0 then '0' else round(mc.n::numeric * 100 / mc.d, 1)::text end,
    'perT', case when mc.d = 0 then '0' else round(mc.t::numeric * 100 / mc.d, 1)::text end,
    'perAsiEksklusif', case when mc.asi_target = 0 then '0' else round(mc.asi_eksklusif::numeric * 100 / mc.asi_target, 1)::text end,
    'perUnderweight', case when mc.d = 0 then '0' else round(nc.underweight::numeric * 100 / mc.d, 1)::text end,
    'perStunting', case when mc.d = 0 then '0' else round(nc.stunting::numeric * 100 / mc.d, 1)::text end,
    'perWasting', case when mc.d = 0 then '0' else round(nc.wasting::numeric * 100 / mc.d, 1)::text end
  )
  from basic_counts bc
  cross join measurement_counts mc
  cross join nutrition_counts nc
$$;

revoke all on function public.eposyandu_dashboard_stats(date, date, date, date, text, text, text, text, text) from public;
grant execute on function public.eposyandu_dashboard_stats(date, date, date, date, text, text, text, text, text) to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('023', 'set-based indexed LMS classification for dashboard statistics')
on conflict (version) do nothing;

commit;
