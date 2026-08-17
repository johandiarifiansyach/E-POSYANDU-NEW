begin;

-- WHO arm-circumference-for-age standards begin at 3 completed months.
-- Keep LiLA mandatory from 3 months onward, but store NULL for ages 0-2 months.
do $migration$
declare
  v_definition text;
  v_before text;
begin
  select pg_get_functiondef('public.eposyandu_self_sync_measurement_batch(jsonb)'::regprocedure)
  into v_definition;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
        if nullif(v_data->>'lila', '') is null
          or (v_data->>'lila')::numeric <= 0
          or (v_data->>'lila')::numeric > 50 then
          raise exception 'LiLA harus antara 0,1 sampai 50 cm.';
        end if;
$old$, $new$
        if coalesce(nullif(v_data->>'ageInMonths', '')::integer, 0) < 3 then
          if nullif(v_data->>'lila', '') is not null then
            raise exception 'LiLA tidak diukur pada bayi usia 0 sampai 2 bulan.';
          end if;
        elsif nullif(v_data->>'lila', '') is null
          or (v_data->>'lila')::numeric <= 0
          or (v_data->>'lila')::numeric > 50 then
          raise exception 'LiLA harus antara 0,1 sampai 50 cm mulai usia 3 bulan.';
        end if;
$new$);
  if v_definition = v_before then
    raise exception 'Blok validasi tambah LiLA tidak ditemukan.';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
          (v_data->>'lk')::numeric, (v_data->>'lila')::numeric,
$old$, $new$
          (v_data->>'lk')::numeric, nullif(v_data->>'lila', '')::numeric,
$new$);
  if v_definition = v_before then
    raise exception 'Blok penyimpanan tambah LiLA tidak ditemukan.';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
          if v_data ? 'lila' and (
            nullif(v_data->>'lila', '') is null
            or (v_data->>'lila')::numeric <= 0
            or (v_data->>'lila')::numeric > 50
          ) then
            raise exception 'LiLA harus antara 0,1 sampai 50 cm.';
          end if;
$old$, $new$
          if v_data ? 'lila' then
            if coalesce(
              nullif(v_data->>'ageInMonths', '')::integer,
              v_measurement.age_in_months,
              0
            ) < 3 then
              if nullif(v_data->>'lila', '') is not null then
                raise exception 'LiLA tidak diukur pada bayi usia 0 sampai 2 bulan.';
              end if;
            elsif nullif(v_data->>'lila', '') is null
              or (v_data->>'lila')::numeric <= 0
              or (v_data->>'lila')::numeric > 50 then
              raise exception 'LiLA harus antara 0,1 sampai 50 cm mulai usia 3 bulan.';
            end if;
          end if;
$new$);
  if v_definition = v_before then
    raise exception 'Blok validasi ubah LiLA tidak ditemukan.';
  end if;

  v_before := v_definition;
  v_definition := replace(v_definition, $old$
              mid_upper_arm_circumference_cm = case when v_data ? 'lila' then (v_data->>'lila')::numeric else mid_upper_arm_circumference_cm end,
$old$, $new$
              mid_upper_arm_circumference_cm = case when v_data ? 'lila' then nullif(v_data->>'lila', '')::numeric else mid_upper_arm_circumference_cm end,
$new$);
  if v_definition = v_before then
    raise exception 'Blok penyimpanan ubah LiLA tidak ditemukan.';
  end if;

  execute v_definition;
end;
$migration$;

insert into public.schema_migrations (version, description)
values ('026', 'allow null arm circumference for infants under three months')
on conflict (version) do nothing;

commit;
