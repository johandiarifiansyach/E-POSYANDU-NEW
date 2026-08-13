begin;

-- Versi eksplisit dari halaman balita untuk layanan read replica. Scope akun
-- tetap dihitung dan divalidasi oleh Rust API; Neon tidak menyimpan auth.users
-- dan tidak menerima permintaan langsung dari browser.
create or replace function public.eposyandu_replica_children_page(
  p_as_of date,
  p_measurement_start date,
  p_measurement_end date,
  p_page integer,
  p_size integer,
  p_sort text,
  p_view text default 'data',
  p_search text default null,
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
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
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or c.name ilike '%' || trim(p_search) || '%'
        or c.national_id ilike '%' || trim(p_search) || '%'
      )
      and case p_view
        when 'data' then c.deleted_at is null
          and c.birth_date <= p_as_of
          and c.birth_date > (p_as_of - interval '60 months')::date
        when 'recent' then c.deleted_at is null
          and c.created_at >= p_as_of::timestamptz
          and c.created_at < (p_as_of + interval '1 month')::timestamptz
        when 'recycle' then c.deleted_at is not null
        when 'mpasi' then c.deleted_at is null
          and c.birth_date > (p_as_of - interval '24 months')::date
          and c.birth_date <= (p_as_of - interval '6 months')::date
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
    limit greatest(1, least(coalesce(p_size, 10), 50))
    offset greatest(0, coalesce(p_page, 1) - 1) * greatest(1, least(coalesce(p_size, 10), 50))
  ), latest_measurements as (
    select p.page_order, m.*
    from paged p
    cross join lateral (
      select measurement.*
      from public.measurements measurement
      where coalesce(measurement.child_id, nullif(measurement.legacy_child_id, '')) = p.id
        and measurement.measurement_date between p_measurement_start and p_measurement_end
      order by measurement.measurement_date desc, measurement.created_at desc, measurement.id desc
      limit 1
    ) m
  ), latest_mpasi as (
    select p.page_order, log.*
    from paged p
    cross join lateral (
      select mpasi.*
      from public.mpasi_logs mpasi
      where coalesce(mpasi.child_id, nullif(mpasi.legacy_child_id, '')) = p.id
        and mpasi.monitoring_date between p_measurement_start and p_measurement_end
      order by mpasi.monitoring_date desc, mpasi.created_at desc, mpasi.id desc
      limit 1
    ) log
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id,
      'data', jsonb_build_object(
        'nama', name, 'nik', national_id, 'hasNIK', has_national_id,
        'tglLahir', birth_date, 'jk', sex, 'namaOrtu', parent_name,
        'desa', village, 'posyandu', posyandu,
        'createdAt', created_at, 'updatedAt', updated_at, 'version', version,
        'deletedAt', deleted_at, 'deleteReason', delete_reason
      )
    ) order by page_order) from paged), '[]'::jsonb),
    'measurements', case when p_view = 'mpasi' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'data', jsonb_build_object(
          'childId', coalesce(child_id, nullif(legacy_child_id, '')),
          'childName', legacy_child_name, 'desa', legacy_village, 'posyandu', legacy_posyandu,
          'tglUkur', measurement_date, 'bb', weight_kg, 'tb', height_cm,
          'lk', head_circumference_cm, 'lila', mid_upper_arm_circumference_cm,
          'edema', edema, 'kelasIbu', mother_class_attendance, 'mbg', mbg,
          'vitA', vitamin_a, 'asi', exclusive_breastfeeding,
          'caraUkur', measurement_method, 'statusNaik', weight_gain_status,
          'ageInMonths', age_in_months, 'createdAt', created_at,
          'updatedAt', updated_at, 'version', version
        )
      ) order by page_order) from latest_measurements
    ), '[]'::jsonb) end,
    'mpasiLogs', case when p_view <> 'mpasi' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id,
        'data', jsonb_build_object(
          'childId', coalesce(child_id, nullif(legacy_child_id, '')),
          'childName', legacy_child_name, 'tglMonitoring', monitoring_date,
          'asi', breastfeeding,
          'makananPokok', case when staple_food then jsonb_build_array('Ya') else '[]'::jsonb end,
          'kacang', case when legumes then jsonb_build_array('Ya') else '[]'::jsonb end,
          'susu', case when dairy then jsonb_build_array('Ya') else '[]'::jsonb end,
          'daging', case when meat then jsonb_build_array('Ya') else '[]'::jsonb end,
          'telur', case when eggs then jsonb_build_array('Ya') else '[]'::jsonb end,
          'sayurVitA', case when vitamin_a_fruit_vegetable then jsonb_build_array('Ya') else '[]'::jsonb end,
          'sayurLain', case when other_fruit_vegetable then jsonb_build_array('Ya') else '[]'::jsonb end,
          'intervensiGizi', nutrition_intervention,
          'createdAt', created_at, 'updatedAt', updated_at, 'version', version
        )
      ) order by page_order) from latest_mpasi
    ), '[]'::jsonb) end,
    'total', (select count(*) from scoped)
  ) into v_result;

  return coalesce(v_result, jsonb_build_object(
    'items', '[]'::jsonb,
    'measurements', '[]'::jsonb,
    'mpasiLogs', '[]'::jsonb,
    'total', 0
  ));
end;
$$;

revoke all on function public.eposyandu_replica_children_page(
  date, date, date, integer, integer, text, text, text, text, text, text, text, text
) from public;
grant execute on function public.eposyandu_replica_children_page(
  date, date, date, integer, integer, text, text, text, text, text, text, text, text
) to service_role;

insert into public.schema_migrations (version, description)
values ('020', 'role-scoped child page for a private read replica')
on conflict (version) do nothing;

commit;
