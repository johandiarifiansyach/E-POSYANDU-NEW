begin;

-- Shared age-cohort predicate used by dashboard and every child table.  The
-- predicate intentionally uses the report/reference date, not the browser's
-- clock, so a report is reproducible when the month selector changes.
create or replace function public.eposyandu_age_group_match(
  p_age_group text,
  p_birth_date date,
  p_reference_date date,
  p_gestational_age_weeks smallint
) returns boolean
language sql
immutable
as $$
  with age_values as (
    select
      greatest(0, (extract(year from age(p_reference_date, p_birth_date)) * 12
        + extract(month from age(p_reference_date, p_birth_date)))::integer) as age_months,
      (p_reference_date - p_birth_date) as age_days
  )
  select case coalesce(nullif(trim(p_age_group), ''), '0-60')
    when 'newborn' then age_days between 0 and 28
    when 'newborn_premature' then age_days between 0 and 28
      and p_gestational_age_weeks > 0 and p_gestational_age_weeks < 37
    when '0-60' then age_months between 0 and 60
    when '0-5' then age_months between 0 and 5
    when '6' then age_months = 6
    when '0-11' then age_months between 0 and 11
    when '0-23' then age_months between 0 and 23
    when '6-11' then age_months between 6 and 11
    when '6-23' then age_months between 6 and 23
    when '12-23' then age_months between 12 and 23
    when '6-60' then age_months between 6 and 60
    when '12-60' then age_months between 12 and 60
    when '24-60' then age_months between 24 and 60
    else false
  end
  from age_values
  where p_birth_date is not null
    and p_reference_date is not null
    and p_birth_date <= p_reference_date;
$$;

-- Keep the SigiZI export on the same age-cohort contract.  The legacy export
-- function remains available during rolling migration; this overload applies
-- the shared predicate to its rows so a selected cohort never leaks into an
-- export from another age group.
create or replace function public.eposyandu_sigizi_measurement_export(
  p_month_start date,
  p_month_end date,
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
  with legacy as (
    select value as item
    from jsonb_array_elements(coalesce(
      public.eposyandu_sigizi_measurement_export(
        p_month_start => p_month_start,
        p_month_end => p_month_end,
        p_village => p_village,
        p_posyandu => p_posyandu,
        p_role => p_role,
        p_scope_village => p_scope_village,
        p_scope_posyandu => p_scope_posyandu
      )->'items', '[]'::jsonb
    ))
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(legacy.item order by lower(coalesce(legacy.item->>'nama', '')), legacy.item->>'nik'), '[]'::jsonb)
  )
  from legacy
  join public.children c on c.national_id = nullif(legacy.item->>'nik', '')
  where c.deleted_at is null
    and public.eposyandu_age_group_match(p_age_group, c.birth_date, p_month_end, c.gestational_age_weeks);
$$;

-- Dashboard input projection.  PostgreSQL performs only cheap scope/period
-- selection; Python remains the authority for WHO, z-score, N/T/O/B, ASI,
-- risk, education, and clinical aggregates.
create or replace function public.eposyandu_dashboard_dataset(
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  -- All arguments on the new overload are required so the legacy
  -- nine-argument function stays unambiguous during a rolling migration.
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
  with active_children as materialized (
    select c.id, c.name, c.national_id, c.birth_date, c.sex, c.village,
      c.posyandu, c.created_at, c.updated_at, c.deleted_at, c.version,
      c.gestational_age_weeks
    from public.children c
    where c.deleted_at is null
      and public.eposyandu_age_group_match(p_age_group, c.birth_date, p_month_end, c.gestational_age_weeks)
      and (p_village is null or c.village = p_village)
      and (p_posyandu is null or c.posyandu = p_posyandu)
      and (p_role in ('Ahli Gizi', 'super_admin') or c.village = p_scope_village)
      and (p_role <> 'Kader Posyandu' or c.posyandu = p_scope_posyandu)
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
  ), technical as (
    select jsonb_build_object(
      'source', 'postgresql-dashboard-input-v2',
      'ageGroup', p_age_group,
      'activeChildCount', (select count(*)::integer from active_children),
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
    'technical', (select value from technical)
  );
$$;

-- Read-replica child page with age selection before pagination.  This keeps
-- totals and page boundaries correct for every cohort, including newborn and
-- premature newborn, instead of filtering an already-limited page in Rust.
create or replace function public.eposyandu_replica_children_page(
  p_as_of date,
  p_measurement_start date,
  p_measurement_end date,
  p_page integer,
  p_size integer,
  p_sort text,
  p_view text,
  p_search text,
  p_village text,
  p_posyandu text,
  p_role text,
  p_scope_village text,
  p_scope_posyandu text,
  -- Required on the new overload so calls to the legacy 13-argument
  -- read-replica function continue to resolve without ambiguity.
  p_age_group text
) returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if p_view not in ('data', 'recent', 'recycle', 'mpasi') then
    raise exception 'Tampilan data balita tidak valid.';
  end if;
  if p_sort not in ('recent', 'oldest_input', 'name_asc', 'name_desc', 'age_oldest', 'age_youngest') then
    raise exception 'Urutan data balita tidak valid.';
  end if;
  with scoped as (
    select c.*
    from public.children c
    where public.eposyandu_scope_match(
      c.village, c.posyandu, nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
      p_role, p_scope_village, p_scope_posyandu
    )
      and public.eposyandu_age_group_match(p_age_group, c.birth_date, p_as_of, c.gestational_age_weeks)
      and (nullif(trim(coalesce(p_search, '')), '') is null
        or c.name ilike '%' || trim(p_search) || '%'
        or c.national_id ilike '%' || trim(p_search) || '%')
      and case p_view
        when 'data' then c.deleted_at is null and c.birth_date <= p_as_of
        when 'recent' then c.deleted_at is null and c.created_at >= p_as_of::timestamptz and c.created_at < (p_as_of + interval '1 month')::timestamptz
        when 'recycle' then c.deleted_at is not null
        when 'mpasi' then c.deleted_at is null and public.eposyandu_age_months(c.birth_date, p_as_of) between 6 and 23
        else false
      end
  ), ordered as (
    select scoped.*, row_number() over (order by
      case when p_sort = 'name_asc' then lower(name) end asc nulls last,
      case when p_sort = 'name_desc' then lower(name) end desc nulls last,
      case when p_sort = 'oldest_input' then created_at end asc nulls last,
      case when p_sort = 'recent' then created_at end desc nulls last,
      case when p_sort = 'age_oldest' then birth_date end asc nulls last,
      case when p_sort = 'age_youngest' then birth_date end desc nulls last,
      lower(name), id) as page_order
    from scoped
  ), paged as (
    select * from ordered order by page_order
    limit greatest(1, least(coalesce(p_size, 10), 50))
    offset greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
  ), latest_measurements as (
    select p.page_order, m.* from paged p
    cross join lateral (
      select measurement.* from public.measurements measurement
      where coalesce(measurement.child_id, nullif(measurement.legacy_child_id, '')) = p.id
        and measurement.measurement_date between p_measurement_start and p_measurement_end
      order by measurement.measurement_date desc, measurement.created_at desc, measurement.id desc limit 1
    ) m
  ), latest_mpasi as (
    select p.page_order, log.* from paged p
    cross join lateral (
      select mpasi.* from public.mpasi_logs mpasi
      where coalesce(mpasi.child_id, nullif(mpasi.legacy_child_id, '')) = p.id
        and mpasi.monitoring_date between p_measurement_start and p_measurement_end
      order by mpasi.monitoring_date desc, mpasi.created_at desc, mpasi.id desc limit 1
    ) log
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'data', jsonb_build_object(
      'nama', name, 'nik', national_id, 'hasNIK', has_national_id, 'tglLahir', birth_date,
      'jk', sex, 'namaOrtu', parent_name, 'desa', village, 'posyandu', posyandu,
      'usiaKehamilan', gestational_age_weeks, 'createdAt', created_at, 'updatedAt', updated_at,
      'version', version, 'deletedAt', deleted_at, 'deleteReason', delete_reason
    )) order by page_order) from paged), '[]'::jsonb),
    'measurements', case when p_view = 'mpasi' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'data', jsonb_build_object('childId', coalesce(child_id, nullif(legacy_child_id, '')),
      'childName', legacy_child_name, 'desa', legacy_village, 'posyandu', legacy_posyandu,
      'tglUkur', measurement_date, 'bb', weight_kg, 'tb', height_cm, 'lk', head_circumference_cm,
      'lila', mid_upper_arm_circumference_cm, 'edema', edema, 'kelasIbu', mother_class_attendance,
      'mbg', mbg, 'vitA', vitamin_a, 'asi', exclusive_breastfeeding, 'caraUkur', measurement_method,
      'statusNaik', weight_gain_status, 'ageInMonths', age_in_months, 'createdAt', created_at,
      'updatedAt', updated_at, 'version', version)) order by page_order) from latest_measurements), '[]'::jsonb) end,
    'mpasiLogs', case when p_view <> 'mpasi' then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'data', jsonb_build_object('childId', coalesce(child_id, nullif(legacy_child_id, '')),
      'childName', legacy_child_name, 'tglMonitoring', monitoring_date, 'asi', breastfeeding,
      'makananPokok', case when staple_food then jsonb_build_array('Ya') else '[]'::jsonb end,
      'kacang', case when legumes then jsonb_build_array('Ya') else '[]'::jsonb end,
      'susu', case when dairy then jsonb_build_array('Ya') else '[]'::jsonb end,
      'daging', case when meat then jsonb_build_array('Ya') else '[]'::jsonb end,
      'telur', case when eggs then jsonb_build_array('Ya') else '[]'::jsonb end,
      'sayurVitA', case when vitamin_a_fruit_vegetable then jsonb_build_array('Ya') else '[]'::jsonb end,
      'sayurLain', case when other_fruit_vegetable then jsonb_build_array('Ya') else '[]'::jsonb end,
      'intervensiGizi', nutrition_intervention, 'createdAt', created_at, 'updatedAt', updated_at,
      'version', version)) order by page_order) from latest_mpasi), '[]'::jsonb) end,
    'total', (select count(*) from scoped)
  ) into v_result;
  return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'measurements', '[]'::jsonb, 'mpasiLogs', '[]'::jsonb, 'total', 0));
end;
$$;

-- Materialized status projection.  For normal tabs, page selection is done by
-- the age-aware replica function and Python-derived columns are joined from
-- measurement_analysis.  Problem tabs use the same predicate before status
-- filtering, keeping their totals consistent with the selected cohort.
create or replace function public.eposyandu_materialized_children_page(
  p_as_of date, p_measurement_start date, p_measurement_end date,
  p_page integer, p_size integer, p_sort text, p_view text,
  p_search text, p_village text, p_posyandu text,
  p_role text, p_scope_village text, p_scope_posyandu text, p_age_group text
) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_result jsonb;
begin
  if p_view not in (
    'data', 'recent', 'recycle', 'mpasi',
    'problem_underweight', 'problem_stunting', 'problem_wasting', 'problem_tidak_naik'
  ) then
    raise exception 'Tampilan data balita tidak valid.';
  end if;
  if p_sort not in ('recent', 'oldest_input', 'name_asc', 'name_desc', 'age_oldest', 'age_youngest') then
    raise exception 'Urutan data balita tidak valid.';
  end if;
  if p_view like 'problem_%' then
    with scoped as (
      select c.* from public.children c
      where c.deleted_at is null
        and public.eposyandu_age_group_match(p_age_group, c.birth_date, p_as_of, c.gestational_age_weeks)
        and public.eposyandu_scope_match(c.village, c.posyandu, nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''), p_role, p_scope_village, p_scope_posyandu)
        and (nullif(trim(coalesce(p_search, '')), '') is null or c.name ilike '%' || trim(p_search) || '%' or c.national_id ilike '%' || trim(p_search) || '%')
    ), latest as (
      select distinct on (c.id) c.id as child_id, c.name, c.national_id, c.has_national_id,
        c.birth_date, c.sex, c.parent_name, c.village, c.posyandu, c.created_at, c.updated_at,
        c.version, c.deleted_at, c.delete_reason, m.id as measurement_id, m.legacy_child_name,
        m.legacy_village, m.legacy_posyandu, m.measurement_date, m.weight_kg, m.height_cm,
        m.head_circumference_cm, m.mid_upper_arm_circumference_cm, m.edema,
        m.mother_class_attendance, m.mbg, m.vitamin_a, m.exclusive_breastfeeding,
        m.measurement_method, m.age_in_months, m.created_at as measurement_created_at,
        m.updated_at as measurement_updated_at, m.version as measurement_version,
        a.bbu_status, a.tbu_status, a.bbtb_status, a.imtu_status, a.lila_status, a.lk_status,
        a.bbu_z_score, a.tbu_z_score, a.bbtb_z_score, a.imtu_z_score, a.lila_z_score,
        a.lk_z_score, a.weight_gain_status, a.weight_gain_minimum_grams,
        a.exclusive_breastfeeding_status, a.result_json
      from scoped c join public.measurements m on coalesce(m.child_id, nullif(m.legacy_child_id, '')) = c.id
      join public.measurement_analysis a on a.measurement_id = m.id
      where m.measurement_date between p_measurement_start and p_measurement_end
      order by c.id, m.measurement_date desc, m.created_at desc, m.id desc
    ), filtered as (
      select * from latest l where
        (p_view = 'problem_underweight' and l.bbu_status in ('Berat Sangat Kurang', 'Berat Kurang'))
        or (p_view = 'problem_stunting' and l.tbu_status in ('Sangat Pendek', 'Pendek'))
        or (p_view = 'problem_wasting' and l.bbtb_status in ('Gizi Buruk', 'Gizi Kurang'))
        or (p_view = 'problem_tidak_naik' and l.weight_gain_status = 'T')
    ), ordered as (
      select f.*, row_number() over (order by
        case when p_sort = 'name_asc' then lower(f.name) end asc nulls last,
        case when p_sort = 'name_desc' then lower(f.name) end desc nulls last,
        case when p_sort = 'oldest_input' then f.created_at end asc nulls last,
        case when p_sort = 'recent' then f.created_at end desc nulls last,
        case when p_sort = 'age_oldest' then f.birth_date end asc nulls last,
        case when p_sort = 'age_youngest' then f.birth_date end desc nulls last,
        lower(f.name), f.child_id) as page_order from filtered f
    ), paged as (
      select * from ordered where page_order > greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
        and page_order <= greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50)) + greatest(1, least(coalesce(p_size, 10), 50))
    )
    select jsonb_build_object(
      'items', coalesce((select jsonb_agg(jsonb_build_object('id', child_id, 'data', jsonb_build_object(
        'nama', name, 'nik', national_id, 'hasNIK', has_national_id, 'tglLahir', birth_date, 'jk', sex,
        'namaOrtu', parent_name, 'desa', village, 'posyandu', posyandu, 'createdAt', created_at,
        'updatedAt', updated_at, 'version', version, 'deletedAt', deleted_at, 'deleteReason', delete_reason
      )) order by page_order) from paged), '[]'::jsonb),
      'measurements', coalesce((select jsonb_agg(jsonb_build_object('id', measurement_id, 'data', jsonb_build_object(
        'childId', child_id, 'childName', legacy_child_name, 'desa', legacy_village, 'posyandu', legacy_posyandu,
        'tglUkur', measurement_date, 'bb', weight_kg, 'tb', height_cm, 'lk', head_circumference_cm,
        'lila', mid_upper_arm_circumference_cm, 'edema', edema, 'kelasIbu', mother_class_attendance, 'mbg', mbg,
        'vitA', vitamin_a, 'asi', exclusive_breastfeeding, 'caraUkur', measurement_method, 'ageInMonths', age_in_months,
        'createdAt', measurement_created_at, 'updatedAt', measurement_updated_at, 'version', measurement_version,
        'statusNaik', weight_gain_status, 'weightGainStatus', weight_gain_status, 'weightGainMinimumGrams', weight_gain_minimum_grams,
        'bbuStatus', bbu_status, 'tbuStatus', tbu_status, 'bbtbStatus', bbtb_status, 'imtuStatus', imtu_status,
        'lilaStatus', lila_status, 'lkStatus', lk_status, 'bbuZScore', bbu_z_score, 'tbuZScore', tbu_z_score,
        'bbtbZScore', bbtb_z_score, 'imtuZScore', imtu_z_score, 'lilaZScore', lila_z_score, 'lkZScore', lk_z_score,
        'exclusiveBreastfeedingStatus', exclusive_breastfeeding_status, 'analysis', result_json, 'analysisPending', false
      )) order by page_order) from paged), '[]'::jsonb),
      'mpasiLogs', '[]'::jsonb, 'total', (select count(*) from filtered), 'pageLimited', false,
      'calculator', 'python-deterministic-lms', 'analytics', 'postgresql-read-python-write-v1', 'standardsVersion', 'WHO-2006-2007-LMS'
    ) into v_result;
    return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'measurements', '[]'::jsonb, 'mpasiLogs', '[]'::jsonb, 'total', 0));
  end if;

  v_result := public.eposyandu_replica_children_page(
    p_as_of, p_measurement_start, p_measurement_end, p_page, p_size, p_sort,
    p_view, p_search, p_village, p_posyandu, p_role, p_scope_village, p_scope_posyandu, p_age_group
  );
  return jsonb_build_object(
    'items', coalesce(v_result->'items', '[]'::jsonb),
    'measurements', coalesce((select jsonb_agg(jsonb_set(elem.value, '{data}', coalesce(elem.value->'data', '{}'::jsonb) || case when a.measurement_id is null then jsonb_build_object(
      'bbuStatus', null, 'tbuStatus', null, 'bbtbStatus', null, 'imtuStatus', null, 'lilaStatus', null, 'lkStatus', null,
      'bbuZScore', null, 'tbuZScore', null, 'bbtbZScore', null, 'imtuZScore', null, 'lilaZScore', null, 'lkZScore', null,
      'statusNaik', null, 'weightGainStatus', null, 'weightGainMinimumGrams', null, 'exclusiveBreastfeedingStatus', null,
      'analysis', null, 'analysisPending', true
    ) else jsonb_build_object(
      'bbuStatus', a.bbu_status, 'tbuStatus', a.tbu_status, 'bbtbStatus', a.bbtb_status, 'imtuStatus', a.imtu_status,
      'lilaStatus', a.lila_status, 'lkStatus', a.lk_status, 'bbuZScore', a.bbu_z_score, 'tbuZScore', a.tbu_z_score,
      'bbtbZScore', a.bbtb_z_score, 'imtuZScore', a.imtu_z_score, 'lilaZScore', a.lila_z_score, 'lkZScore', a.lk_z_score,
      'statusNaik', a.weight_gain_status, 'weightGainStatus', a.weight_gain_status,
      'weightGainMinimumGrams', a.weight_gain_minimum_grams, 'exclusiveBreastfeedingStatus', a.exclusive_breastfeeding_status,
      'analysis', a.result_json, 'analysisPending', false
    ) end) order by elem.ordinality) from jsonb_array_elements(coalesce(v_result->'measurements', '[]'::jsonb)) with ordinality elem(value, ordinality)
      left join public.measurement_analysis a on a.measurement_id = elem.value->>'id'), '[]'::jsonb),
    'mpasiLogs', coalesce(v_result->'mpasiLogs', '[]'::jsonb), 'total', coalesce(v_result->'total', '0'::jsonb), 'pageLimited', true,
    'calculator', 'python-deterministic-lms', 'analytics', 'postgresql-read-python-write-v1', 'standardsVersion', 'WHO-2006-2007-LMS',
    'analysisVersion', (select coalesce(max(analysis_version), 0) from public.measurement_analysis)
  );
end;
$$;

-- Keep the read-replica RPC contract age-aware for problem tabs as well.  The
-- original 12-argument function is retained for older callers; this overload
-- delegates to the materialized projection so status filtering and the age
-- predicate happen before pagination.
create or replace function public.eposyandu_problem_children_page(
  p_month_start date,
  p_month_end date,
  p_problem text,
  p_page integer,
  p_size integer,
  p_search text,
  p_sort text,
  p_village text,
  p_posyandu text,
  p_role text,
  p_scope_village text,
  p_scope_posyandu text,
  -- Required on the new overload so the legacy 12-argument problem RPC is
  -- still callable while old workers are being drained.
  p_age_group text
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_materialized_children_page(
    p_month_end,
    p_month_start,
    p_month_end,
    p_page,
    p_size,
    p_sort,
    p_problem,
    p_search,
    p_village,
    p_posyandu,
    p_role,
    p_scope_village,
    p_scope_posyandu,
    p_age_group
  );
$$;

-- ASI table uses the same cohort predicate as every other table.  Python has
-- already decided whether the 0-6-month context is complete; this function
-- only reads that persisted result and applies scope/period/age selection.
create or replace function public.eposyandu_materialized_exclusive_breastfeeding_page(
  p_measurement_start date, p_measurement_end date, p_age_group text,
  p_page integer, p_size integer, p_village text default null, p_posyandu text default null,
  p_role text default 'Ahli Gizi', p_scope_village text default null, p_scope_posyandu text default null
) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  with selected as (
    select c.id, c.name, c.national_id, c.has_national_id, c.birth_date, c.village, c.posyandu,
      m.measurement_date, m.age_in_months
    from public.children c
    join public.measurements m on coalesce(m.child_id, nullif(m.legacy_child_id, '')) = c.id
    join public.measurement_analysis a on a.measurement_id = m.id and a.exclusive_breastfeeding_status = 'Ya'
    where c.deleted_at is null
      and m.measurement_date between p_measurement_start and p_measurement_end
      and public.eposyandu_age_group_match(p_age_group, c.birth_date, m.measurement_date, c.gestational_age_weeks)
      and public.eposyandu_scope_match(c.village, c.posyandu, p_village, p_posyandu, p_role, p_scope_village, p_scope_posyandu)
  ), paged as (
    select * from selected order by lower(name), id
    limit greatest(1, least(coalesce(p_size, 10), 50))
    offset greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'data', jsonb_build_object(
      'nama', name, 'nik', national_id, 'hasNIK', has_national_id, 'tglLahir', birth_date,
      'desa', village, 'posyandu', posyandu, 'tglUkur', measurement_date, 'ageInMonths', age_in_months, 'asiStatus', 'Ya'
    )) order by lower(name), id) from paged), '[]'::jsonb), 'total', (select count(*) from selected),
    'calculator', 'python-materialized-asi-context-v1', 'analytics', 'postgresql-read-python-write-v1'
  );
$$;

-- Preserve the legacy ASI RPC name for read-replica callers while routing it
-- through the same materialized Python projection.  This keeps every age
-- cohort (not only the historical 0-5/6 buttons) consistent during rollout.
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
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_materialized_exclusive_breastfeeding_page(
    p_measurement_start,
    p_measurement_end,
    p_age_group,
    p_page,
    p_size,
    p_village,
    p_posyandu,
    p_role,
    p_scope_village,
    p_scope_posyandu
  );
$$;

-- Change history is a child-scoped table as well.  Resolve the child before
-- pagination so an age cohort never changes the number of rows on a page.
create or replace function public.eposyandu_change_history_page(
  p_as_of date,
  p_page integer,
  p_size integer,
  p_age_group text default '0-60',
  p_search text default null,
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
  with scoped as (
    select l.id,
      coalesce(nullif(l.child_name, ''), c.name, '') as child_name,
      l.changed_by,
      l.changed_at,
      c.id as resolved_child_id
    from public.change_logs l
    join public.children c
      on c.id = coalesce(l.child_id, nullif(l.legacy_child_id, ''))
    where (
        public.eposyandu_age_group_match(
          p_age_group, c.birth_date, p_as_of, c.gestational_age_weeks
        )
      )
      and public.eposyandu_scope_match(
        c.village, c.posyandu,
        nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
        p_role, p_scope_village, p_scope_posyandu
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or coalesce(nullif(l.child_name, ''), c.name, '') ilike '%' || trim(p_search) || '%'
        or coalesce(c.national_id, '') ilike '%' || trim(p_search) || '%'
      )
  ), numbered as (
    select s.*,
      row_number() over (order by s.changed_at desc, s.id desc) as page_order
    from scoped s
  ), paged as (
    select n.*,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'field', e.field_name,
          'oldValue', e.old_value,
          'newValue', e.new_value
        ) order by e.id)
        from public.change_log_entries e
        where e.change_log_id = n.id
      ), '[]'::jsonb) as changes
    from numbered n
    where n.page_order > greatest(0, coalesce(p_page, 1) - 1)
      * greatest(1, least(coalesce(p_size, 10), 50))
      and n.page_order <= greatest(0, coalesce(p_page, 1) - 1)
      * greatest(1, least(coalesce(p_size, 10), 50))
      + greatest(1, least(coalesce(p_size, 10), 50))
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'data', jsonb_build_object(
          'childName', p.child_name,
          'changedBy', p.changed_by,
          'timestamp', p.changed_at,
          'changes', p.changes
        )
      ) order by p.page_order)
      from paged p
    ), '[]'::jsonb),
    'total', (select count(*) from scoped),
    'page', greatest(1, coalesce(p_page, 1)),
    'size', greatest(1, least(coalesce(p_size, 10), 50))
  );
$$;

-- Age is part of the cache key in Rust; the snapshot predicate is kept
-- explicit so a stale result from another cohort can never be returned.
create or replace function public.eposyandu_dashboard_snapshot(
  p_cache_key text, p_scope_key text, p_month_start date, p_month_end date,
  p_previous_month_start date, p_previous_month_end date, p_age_group text,
  p_village text, p_posyandu text
) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select coalesce((select jsonb_build_object('hit', true, 'result', d.result_json,
      'sourceVersion', d.source_scope_version, 'analytics', 'python-dashboard-materialized-v1')
    from public.dashboard_analysis d join public.analysis_scope_versions s on s.scope_key = d.scope_key
    where d.cache_key = p_cache_key and d.scope_key = coalesce(nullif(trim(p_scope_key), ''), 'global')
      and d.month_start = p_month_start and d.month_end = p_month_end
      and d.previous_month_start = p_previous_month_start and d.previous_month_end = p_previous_month_end
      and d.source_scope_version = s.version limit 1), jsonb_build_object('hit', false));
$$;

revoke all on function public.eposyandu_age_group_match(text,date,date,smallint) from public;
revoke all on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) from public;
revoke all on function public.eposyandu_replica_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text,text) from public;
revoke all on function public.eposyandu_materialized_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text,text) from public;
revoke all on function public.eposyandu_problem_children_page(date,date,text,integer,integer,text,text,text,text,text,text,text,text) from public;
revoke all on function public.eposyandu_materialized_exclusive_breastfeeding_page(date,date,text,integer,integer,text,text,text,text,text) from public;
revoke all on function public.eposyandu_change_history_page(date,integer,integer,text,text,text,text,text,text,text) from public;
revoke all on function public.eposyandu_dashboard_snapshot(text,text,date,date,date,date,text,text,text) from public;
revoke all on function public.eposyandu_sigizi_measurement_export(date,date,text,text,text,text,text,text) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) to service_role';
    execute 'grant execute on function public.eposyandu_replica_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text,text) to service_role';
    execute 'grant execute on function public.eposyandu_problem_children_page(date,date,text,integer,integer,text,text,text,text,text,text,text,text) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'eposyandu_api') then
    execute 'grant execute on function public.eposyandu_dashboard_dataset(date,date,date,date,text,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_replica_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_materialized_children_page(date,date,date,integer,integer,text,text,text,text,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_problem_children_page(date,date,text,integer,integer,text,text,text,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_materialized_exclusive_breastfeeding_page(date,date,text,integer,integer,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_change_history_page(date,integer,integer,text,text,text,text,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_dashboard_snapshot(text,text,date,date,date,date,text,text,text) to eposyandu_api';
    execute 'grant execute on function public.eposyandu_sigizi_measurement_export(date,date,text,text,text,text,text,text) to eposyandu_api';
  end if;
end
$$;

insert into public.schema_migrations (version, description)
values ('039', 'shared age-group filtering for dashboard and child tables')
on conflict (version) do nothing;

commit;
