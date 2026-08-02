begin;

-- Menyusun ekspor Sigizi langsung di PostgreSQL. Browser hanya menerima
-- kolom yang menjadi isi Excel, bukan seluruh riwayat penimbangan.
create or replace function public.eposyandu_sigizi_measurement_export(
  p_month_start date,
  p_month_end date,
  p_village text default null,
  p_posyandu text default null,
  p_role text default 'Ahli Gizi',
  p_scope_village text default null,
  p_scope_posyandu text default null
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  result jsonb;
begin
  -- EXECUTE membuat PostgreSQL memilih rencana berdasarkan filter ekspor
  -- yang benar. Rencana generik jauh lebih lambat untuk seluruh wilayah.
  execute $query$
  with scoped_children as (
    select c.id, c.name, c.national_id, c.birth_date, c.village, c.posyandu
    from public.children c
    where c.deleted_at is null
      and c.birth_date is not null
      and c.birth_date <= $1
      and c.birth_date > ($1 - interval '60 months')::date
      and public.eposyandu_scope_match(
        c.village, c.posyandu, $3, $4, $5, $6, $7
      )
  ),
  latest_current_measurements as (
    select distinct on (m.child_id)
      m.child_id, m.measurement_date, m.weight_kg, m.height_cm,
      m.mid_upper_arm_circumference_cm, m.head_circumference_cm, m.edema,
      m.measurement_method, m.vitamin_a, m.mother_class_attendance, m.mbg
    from public.measurements m
    join scoped_children c on c.id = m.child_id
    where m.measurement_date between $1 and $2
    order by m.child_id, m.measurement_date desc, m.created_at desc
  ),
  latest_asi_by_age as (
    select distinct on (m.child_id, public.eposyandu_age_months(c.birth_date, m.measurement_date))
      m.child_id,
      public.eposyandu_age_months(c.birth_date, m.measurement_date) as age_in_months,
      m.exclusive_breastfeeding
    from public.measurements m
    join scoped_children c on c.id = m.child_id
    where m.measurement_date between c.birth_date and $2
      and public.eposyandu_age_months(c.birth_date, m.measurement_date) between 0 and 6
    order by m.child_id, public.eposyandu_age_months(c.birth_date, m.measurement_date),
      m.measurement_date desc, m.created_at desc
  ),
  asi_columns as (
    select child_id,
      max(exclusive_breastfeeding) filter (where age_in_months = 0) as asi_bulan_0,
      max(exclusive_breastfeeding) filter (where age_in_months = 1) as asi_bulan_1,
      max(exclusive_breastfeeding) filter (where age_in_months = 2) as asi_bulan_2,
      max(exclusive_breastfeeding) filter (where age_in_months = 3) as asi_bulan_3,
      max(exclusive_breastfeeding) filter (where age_in_months = 4) as asi_bulan_4,
      max(exclusive_breastfeeding) filter (where age_in_months = 5) as asi_bulan_5,
      max(exclusive_breastfeeding) filter (where age_in_months = 6) as asi_bulan_6
    from latest_asi_by_age
    group by child_id
  )
  select jsonb_build_object(
    'items', coalesce(jsonb_agg(jsonb_build_object(
      'nik', c.national_id,
      'nama', c.name,
      'tglUkur', m.measurement_date,
      'bb', m.weight_kg,
      'tb', m.height_cm,
      'lila', m.mid_upper_arm_circumference_cm,
      'lk', m.head_circumference_cm,
      'edema', coalesce(m.edema, ''),
      'caraUkur', coalesce(m.measurement_method, ''),
      'vitA', coalesce(m.vitamin_a, ''),
      'asiBulan0', coalesce(a.asi_bulan_0, ''),
      'asiBulan1', coalesce(a.asi_bulan_1, ''),
      'asiBulan2', coalesce(a.asi_bulan_2, ''),
      'asiBulan3', coalesce(a.asi_bulan_3, ''),
      'asiBulan4', coalesce(a.asi_bulan_4, ''),
      'asiBulan5', coalesce(a.asi_bulan_5, ''),
      'asiBulan6', coalesce(a.asi_bulan_6, ''),
      'kelasIbu', coalesce(m.mother_class_attendance, ''),
      'mbg', coalesce(m.mbg, '')
    ) order by lower(c.name), c.id), '[]'::jsonb)
  )
  from scoped_children c
  left join latest_current_measurements m on m.child_id = c.id
  left join asi_columns a on a.child_id = c.id
$query$
  into result
  using p_month_start, p_month_end, p_village, p_posyandu,
    p_role, p_scope_village, p_scope_posyandu;

  return result;
end;
$$;

create index if not exists idx_measurements_child_date_created
  on public.measurements (child_id, measurement_date desc, created_at desc);

revoke all on function public.eposyandu_sigizi_measurement_export(date, date, text, text, text, text, text) from public;

commit;
