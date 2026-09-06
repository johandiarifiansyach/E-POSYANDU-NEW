begin;

-- Keep the dashboard ASI denominator independent from the selected dashboard
-- cohort. The dashboard always compares exclusive breastfeeding at six
-- completed months with S = every active child who is six months old. The
-- compact asi_measurements history lets Python reject an earlier "Tidak"
-- answer even when the report only covers the current/previous month.
create or replace function public.eposyandu_dashboard_dataset(
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  p_age_group text,
  p_village text,
  p_posyandu text,
  p_role text,
  p_scope_village text,
  p_scope_posyandu text
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scoped_children as materialized (
    select c.id, c.name, c.national_id, c.birth_date, c.sex, c.village,
      c.posyandu, c.created_at, c.updated_at, c.deleted_at, c.version,
      c.gestational_age_weeks
    from public.children c
    where c.deleted_at is null
      and (p_village is null or c.village = p_village)
      and (p_posyandu is null or c.posyandu = p_posyandu)
      and (p_role in ('Ahli Gizi', 'super_admin') or c.village = p_scope_village)
      and (p_role <> 'Kader Posyandu' or c.posyandu = p_scope_posyandu)
  ), active_children as materialized (
    select c.*
    from scoped_children c
    where public.eposyandu_age_group_match(p_age_group, c.birth_date, p_month_end, c.gestational_age_weeks)
  ), asi_children as materialized (
    select c.*
    from scoped_children c
    where public.eposyandu_age_months(c.birth_date, p_month_end) = 6
  ), period_measurements as materialized (
    select m.id, m.child_id, m.legacy_child_id, m.legacy_child_name,
      m.legacy_village, m.legacy_posyandu, m.measurement_date, m.weight_kg,
      m.height_cm, m.head_circumference_cm, m.mid_upper_arm_circumference_cm,
      m.measurement_method, m.weight_gain_status, m.age_in_months,
      m.exclusive_breastfeeding, m.edema, m.mother_class_attendance, m.mbg,
      m.vitamin_a, m.created_at, m.updated_at, m.version
    from public.measurements m
    join active_children c on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date between p_previous_month_start and p_month_end
  ), asi_measurements as materialized (
    select m.id, m.child_id, m.legacy_child_id, m.measurement_date,
      m.age_in_months, m.exclusive_breastfeeding, m.created_at
    from public.measurements m
    join asi_children c on c.id = coalesce(m.child_id, nullif(m.legacy_child_id, ''))
    where m.measurement_date >= c.birth_date
      and m.measurement_date <= p_month_end
      and public.eposyandu_age_months(c.birth_date, m.measurement_date) between 0 and 6
  ), technical as (
    select jsonb_build_object(
      'source', 'postgresql-dashboard-input-v3',
      'ageGroup', p_age_group,
      'activeChildCount', (select count(*)::integer from active_children),
      'asiTargetCount', (select count(*)::integer from asi_children),
      'currentMeasurementRowCount', (select count(*)::integer from period_measurements where measurement_date between p_month_start and p_month_end),
      'previousMeasurementRowCount', (select count(*)::integer from period_measurements where measurement_date between p_previous_month_start and p_previous_month_end),
      'previousMeasuredChildCount', (select count(distinct coalesce(child_id, nullif(legacy_child_id, '')))::integer from period_measurements where measurement_date between p_previous_month_start and p_previous_month_end),
      'createdInMonthCount', (select count(*)::integer from active_children where (created_at at time zone 'Asia/Jakarta') >= p_month_start and (created_at at time zone 'Asia/Jakarta') < (p_month_start + interval '1 month'))
    ) as value
  )
  select jsonb_build_object(
    'children', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'national_id', national_id, 'birth_date', birth_date,
      'sex', sex, 'village', village, 'posyandu', posyandu, 'created_at', created_at,
      'updated_at', updated_at, 'deleted_at', deleted_at, 'version', version
    ) order by id) from active_children), '[]'::jsonb),
    'asiChildren', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'national_id', national_id, 'birth_date', birth_date,
      'sex', sex, 'village', village, 'posyandu', posyandu, 'created_at', created_at,
      'updated_at', updated_at, 'deleted_at', deleted_at, 'version', version
    ) order by id) from asi_children), '[]'::jsonb),
    'measurements', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'child_id', child_id, 'legacy_child_id', legacy_child_id,
      'legacy_child_name', legacy_child_name, 'legacy_village', legacy_village,
      'legacy_posyandu', legacy_posyandu, 'measurement_date', measurement_date,
      'weight_kg', weight_kg, 'height_cm', height_cm,
      'head_circumference_cm', head_circumference_cm,
      'mid_upper_arm_circumference_cm', mid_upper_arm_circumference_cm,
      'measurement_method', measurement_method, 'weight_gain_status', weight_gain_status,
      'age_in_months', age_in_months, 'exclusive_breastfeeding', exclusive_breastfeeding,
      'edema', edema, 'mother_class_attendance', mother_class_attendance,
      'mbg', mbg, 'vitamin_a', vitamin_a, 'created_at', created_at,
      'updated_at', updated_at, 'version', version
    ) order by measurement_date, created_at, id) from period_measurements), '[]'::jsonb),
    'asiMeasurements', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'child_id', child_id, 'legacy_child_id', legacy_child_id,
      'measurement_date', measurement_date, 'age_in_months', age_in_months,
      'exclusive_breastfeeding', exclusive_breastfeeding, 'created_at', created_at
    ) order by measurement_date, created_at, id) from asi_measurements), '[]'::jsonb),
    'technical', (select value from technical)
  );
$$;

revoke all on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'eposyandu_api') then
    execute 'grant execute on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) to eposyandu_api';
  end if;
end;
$$;

insert into public.schema_migrations(version, description)
values ('040', 'dashboard ASI six-month cohort and compact history')
on conflict (version) do nothing;

commit;
