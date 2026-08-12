begin;

-- Read-only emergency endpoints for authenticated browsers. These functions
-- derive the location scope from auth.uid(), so callers cannot widen access by
-- changing village or posyandu parameters while the edge API is unavailable.
create or replace function public.eposyandu_self_children_page(
  p_as_of date,
  p_measurement_start date,
  p_measurement_end date,
  p_page integer,
  p_size integer,
  p_sort text,
  p_view text default 'data',
  p_search text default null,
  p_village text default null,
  p_posyandu text default null
) returns jsonb
language plpgsql
stable
security definer
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

  with access_profile as (
    select users.role, users.village, users.posyandu
    from public.app_users users
    where users.user_id = auth.uid() and users.active
    limit 1
  ), scoped as (
    select c.*
    from public.children c
    cross join access_profile profile
    where public.eposyandu_scope_match(
      c.village, c.posyandu, nullif(trim(p_village), ''), nullif(trim(p_posyandu), ''),
      profile.role, profile.village, profile.posyandu
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

  return coalesce(v_result, jsonb_build_object('items', '[]'::jsonb, 'measurements', '[]'::jsonb, 'mpasiLogs', '[]'::jsonb, 'total', 0));
end;
$$;

create or replace function public.eposyandu_self_problem_children_page(
  p_month_start date,
  p_month_end date,
  p_problem text,
  p_page integer,
  p_size integer,
  p_search text default null,
  p_sort text default 'recent',
  p_village text default null,
  p_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_problem_children_page(
    p_month_start, p_month_end, p_problem, p_page, p_size, p_search, p_sort,
    p_village, p_posyandu, profile.role, profile.village, profile.posyandu
  )
  from public.app_users profile
  where profile.user_id = auth.uid() and profile.active
  limit 1
$$;

create or replace function public.eposyandu_self_exclusive_breastfeeding_page(
  p_measurement_start date,
  p_measurement_end date,
  p_age_group text,
  p_page integer,
  p_size integer,
  p_village text default null,
  p_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_exclusive_breastfeeding_page(
    p_measurement_start, p_measurement_end, p_age_group, p_page, p_size,
    p_village, p_posyandu, profile.role, profile.village, profile.posyandu
  )
  from public.app_users profile
  where profile.user_id = auth.uid() and profile.active
  limit 1
$$;

create or replace function public.eposyandu_self_dashboard_stats(
  p_month_start date,
  p_month_end date,
  p_previous_month_start date,
  p_previous_month_end date,
  p_village text default null,
  p_posyandu text default null
) returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.eposyandu_dashboard_stats(
    p_month_start, p_month_end, p_previous_month_start, p_previous_month_end,
    p_village, p_posyandu, profile.role, profile.village, profile.posyandu
  )
  from public.app_users profile
  where profile.user_id = auth.uid() and profile.active
  limit 1
$$;

create or replace function public.eposyandu_self_child_detail(p_child_id text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', child.id,
    'data', jsonb_build_object(
      'nama', child.name, 'nik', child.national_id, 'anakKe', child.child_order,
      'tglLahir', child.birth_date, 'jk', child.sex, 'noKK', child.family_card_number,
      'hasKK', child.has_family_card, 'hasNIK', child.has_national_id,
      'usiaKehamilan', child.gestational_age_weeks, 'bbLahir', child.birth_weight_kg,
      'pbLahir', child.birth_length_cm, 'lkLahir', child.birth_head_circumference_cm,
      'bukuKIA', case when child.has_maternal_child_book then 'Ya' else 'Tidak' end,
      'bukuKIAKecil', case when child.has_small_baby_book then 'Ya' else 'Tidak' end,
      'imd', case when child.early_breastfeeding_initiation then 'Ya' else 'Tidak' end,
      'namaOrtu', child.parent_name, 'nikOrtu', child.parent_national_id,
      'noHpOrtu', child.parent_phone, 'alamat', child.address,
      'rt', child.rt, 'rw', child.rw, 'desa', child.village, 'posyandu', child.posyandu,
      'currentBB', child.current_weight_kg, 'currentTB', child.current_height_cm,
      'currentLILA', child.current_mid_upper_arm_circumference_cm,
      'currentLK', child.current_head_circumference_cm,
      'lastMeasurementDate', child.last_measurement_date,
      'createdAt', child.created_at, 'createdBy', child.created_by,
      'updatedAt', child.updated_at, 'version', child.version,
      'deletedAt', child.deleted_at, 'deleteReason', child.delete_reason,
      'deathDate', child.death_date, 'deathCause', child.death_cause,
      'deathLocation', child.death_location
    )
  )
  from public.children child
  where child.id = p_child_id
    and exists (
      select 1
      from public.app_users profile
      where profile.user_id = auth.uid()
        and profile.active
        and (
          profile.role = 'Ahli Gizi'
          or (profile.role = 'Bidan Desa' and profile.village = child.village)
          or (
            profile.role = 'Kader Posyandu'
            and profile.village = child.village
            and profile.posyandu = child.posyandu
          )
        )
    )
  limit 1
$$;

revoke all on function public.eposyandu_self_children_page(date, date, date, integer, integer, text, text, text, text, text) from public, anon;
revoke all on function public.eposyandu_self_problem_children_page(date, date, text, integer, integer, text, text, text, text) from public, anon;
revoke all on function public.eposyandu_self_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text) from public, anon;
revoke all on function public.eposyandu_self_dashboard_stats(date, date, date, date, text, text) from public, anon;
revoke all on function public.eposyandu_self_child_detail(text) from public, anon;

grant execute on function public.eposyandu_self_children_page(date, date, date, integer, integer, text, text, text, text, text) to authenticated, service_role;
grant execute on function public.eposyandu_self_problem_children_page(date, date, text, integer, integer, text, text, text, text) to authenticated, service_role;
grant execute on function public.eposyandu_self_exclusive_breastfeeding_page(date, date, text, integer, integer, text, text) to authenticated, service_role;
grant execute on function public.eposyandu_self_dashboard_stats(date, date, date, date, text, text) to authenticated, service_role;
grant execute on function public.eposyandu_self_child_detail(text) to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('017', 'authenticated role-scoped read fallback during edge API outages')
on conflict (version) do nothing;

commit;
