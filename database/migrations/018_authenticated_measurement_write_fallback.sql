begin;

-- Emergency write path for measurement CRUD while the edge API is unavailable.
-- The browser can only submit measurement mutations and derived child-summary
-- updates. Identity fields and records outside the caller's role scope remain
-- inaccessible.
create or replace function public.eposyandu_self_sync_measurement_batch(
  p_mutations jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.app_users%rowtype;
  v_mutation jsonb;
  v_data jsonb;
  v_before jsonb;
  v_after jsonb;
  v_document jsonb;
  v_results jsonb := '[]'::jsonb;
  v_mutation_id text;
  v_operation text;
  v_resource text;
  v_document_id text;
  v_child_id text;
  v_child public.children%rowtype;
  v_measurement public.measurements%rowtype;
  v_expected_version bigint;
  v_inserted integer;
begin
  select users.*
  into v_profile
  from public.app_users users
  where users.user_id = auth.uid()
    and users.active
  limit 1;

  if not found then
    raise exception 'Akun tidak aktif atau belum memiliki akses aplikasi.';
  end if;
  if jsonb_typeof(p_mutations) <> 'array' then
    raise exception 'Daftar perubahan penimbangan tidak valid.';
  end if;
  if jsonb_array_length(p_mutations) < 1 or jsonb_array_length(p_mutations) > 25 then
    raise exception 'Jumlah perubahan penimbangan harus antara 1 dan 25.';
  end if;

  for v_mutation in select value from jsonb_array_elements(p_mutations)
  loop
    v_mutation_id := trim(coalesce(v_mutation->>'id', ''));
    v_operation := trim(coalesce(v_mutation->>'operation', ''));
    v_resource := trim(coalesce(v_mutation->>'resource', ''));
    v_document_id := trim(coalesce(v_mutation->>'documentId', ''));
    v_data := coalesce(v_mutation->'data', '{}'::jsonb);
    v_document := null;
    v_before := null;
    v_after := null;
    v_expected_version := nullif(v_mutation->>'expectedVersion', '')::bigint;

    if v_mutation_id = '' or v_document_id = '' then
      raise exception 'ID perubahan dan ID dokumen wajib diisi.';
    end if;
    if v_operation not in ('add', 'update', 'delete') then
      raise exception 'Operasi penimbangan tidak valid.';
    end if;

    if v_resource = 'measurements' then
      if v_operation in ('add', 'update') and (
        v_data - array[
          'childId', 'childName', 'desa', 'posyandu', 'tglUkur', 'bb', 'tb',
          'lila', 'lk', 'edema', 'kelasIbu', 'mbg', 'vitA', 'asi',
          'caraUkur', 'statusNaik', 'ageInMonths', 'createdAt', 'updatedAt'
        ]::text[]
      ) <> '{}'::jsonb then
        raise exception 'Kolom perubahan penimbangan tidak diizinkan.';
      end if;

      if v_operation = 'add' then
        v_child_id := trim(coalesce(v_data->>'childId', ''));
        if v_child_id = '' or nullif(v_data->>'tglUkur', '') is null then
          raise exception 'Balita dan tanggal pengukuran wajib diisi.';
        end if;

        select child.* into v_child
        from public.children child
        where child.id = v_child_id
          and child.deleted_at is null
        limit 1;
        if not found or not public.eposyandu_location_allowed(v_child.village, v_child.posyandu) then
          raise exception 'Data balita tidak ditemukan atau berada di luar wilayah akun.';
        end if;

        if nullif(v_data->>'bb', '') is null
          or (v_data->>'bb')::numeric < 0.1
          or (v_data->>'bb')::numeric > 60 then
          raise exception 'Berat badan harus antara 0,1 sampai 60 kg.';
        end if;
        if nullif(v_data->>'tb', '') is null
          or (v_data->>'tb')::numeric < 10
          or (v_data->>'tb')::numeric > 220 then
          raise exception 'Panjang atau tinggi badan harus antara 10 sampai 220 cm.';
        end if;
        if nullif(v_data->>'lila', '') is null
          or (v_data->>'lila')::numeric <= 0
          or (v_data->>'lila')::numeric > 50 then
          raise exception 'LiLA harus antara 0,1 sampai 50 cm.';
        end if;
        if nullif(v_data->>'lk', '') is null
          or (v_data->>'lk')::numeric <= 0
          or (v_data->>'lk')::numeric > 80 then
          raise exception 'Lingkar kepala harus antara 0,1 sampai 80 cm.';
        end if;
        if coalesce(v_data->>'statusNaik', 'B') not in ('N', 'T', 'B', 'O') then
          raise exception 'Status kenaikan berat badan tidak valid.';
        end if;

        insert into public.measurements (
          id, child_id, legacy_child_id, legacy_child_name, legacy_village,
          legacy_posyandu, measurement_date, measurement_date_raw, weight_kg,
          height_cm, head_circumference_cm, mid_upper_arm_circumference_cm,
          edema, mother_class_attendance, mbg, vitamin_a,
          exclusive_breastfeeding, measurement_method, weight_gain_status,
          age_in_months, created_at, updated_at
        ) values (
          v_document_id, v_child.id, v_child.id, v_child.name, v_child.village,
          v_child.posyandu, (v_data->>'tglUkur')::date, v_data->>'tglUkur',
          (v_data->>'bb')::numeric, (v_data->>'tb')::numeric,
          (v_data->>'lk')::numeric, (v_data->>'lila')::numeric,
          coalesce(nullif(v_data->>'edema', ''), 'Tidak'),
          coalesce(nullif(v_data->>'kelasIbu', ''), 'Tidak'),
          coalesce(nullif(v_data->>'mbg', ''), 'Tidak'),
          coalesce(nullif(v_data->>'vitA', ''), 'Tidak'),
          coalesce(nullif(v_data->>'asi', ''), 'Tidak'),
          coalesce(v_data->>'caraUkur', ''),
          coalesce(nullif(v_data->>'statusNaik', ''), 'B'),
          nullif(v_data->>'ageInMonths', '')::smallint,
          timezone('utc', now()), timezone('utc', now())
        ) on conflict (id) do nothing;
        get diagnostics v_inserted = row_count;

        select measurement.* into strict v_measurement
        from public.measurements measurement
        where measurement.id = v_document_id;
        if coalesce(v_measurement.child_id, nullif(v_measurement.legacy_child_id, '')) <> v_child.id then
          raise exception 'ID penimbangan sudah digunakan untuk balita lain.';
        end if;
        v_after := to_jsonb(v_measurement);

        delete from public.sync_tombstones
        where resource = 'measurements'
          and document_id = v_document_id;

        if v_inserted > 0 then
          insert into public.audit_events (
            request_id, idempotency_key, actor_user_id, actor_role, action,
            resource, document_id, village, posyandu, before_data, after_data,
            metadata
          ) values (
            'direct-' || v_mutation_id, v_mutation_id, v_profile.user_id::text,
            v_profile.role, 'create', 'measurements', v_document_id,
            v_child.village, v_child.posyandu, null, v_after,
            jsonb_build_object('source', 'authenticated_measurement_fallback')
          ) on conflict (idempotency_key, action, resource, document_id) do nothing;
        end if;
      else
        select measurement.* into v_measurement
        from public.measurements measurement
        where measurement.id = v_document_id
        limit 1;
        if not found then
          if v_operation = 'delete' then
            v_results := v_results || jsonb_build_array(jsonb_build_object(
              'id', v_mutation_id, 'resource', v_resource,
              'documentId', v_document_id, 'operation', v_operation
            ));
            continue;
          end if;
          raise exception 'Data penimbangan tidak ditemukan.';
        end if;

        v_child_id := coalesce(v_measurement.child_id, nullif(v_measurement.legacy_child_id, ''));
        select child.* into v_child from public.children child where child.id = v_child_id limit 1;
        if not found or not public.eposyandu_location_allowed(v_child.village, v_child.posyandu) then
          raise exception 'Data penimbangan berada di luar wilayah akun.';
        end if;
        if v_expected_version is not null
          and v_measurement.version <> v_expected_version
          and not (
            v_operation = 'update'
            and (v_data - array['statusNaik', 'updatedAt']::text[]) = '{}'::jsonb
          ) then
          raise exception 'Data penimbangan telah diperbarui pengguna lain. Muat ulang sebelum menyimpan.';
        end if;
        v_before := to_jsonb(v_measurement);

        if v_operation = 'delete' then
          delete from public.measurements where id = v_document_id;
          insert into public.sync_tombstones (resource, document_id, village, posyandu, deleted_at)
          values ('measurements', v_document_id, v_child.village, v_child.posyandu, timezone('utc', now()))
          on conflict (resource, document_id) do update
          set village = excluded.village,
              posyandu = excluded.posyandu,
              deleted_at = excluded.deleted_at;
          insert into public.audit_events (
            request_id, idempotency_key, actor_user_id, actor_role, action,
            resource, document_id, village, posyandu, before_data, after_data,
            metadata
          ) values (
            'direct-' || v_mutation_id, v_mutation_id, v_profile.user_id::text,
            v_profile.role, 'delete', 'measurements', v_document_id,
            v_child.village, v_child.posyandu, v_before, null,
            jsonb_build_object('source', 'authenticated_measurement_fallback')
          ) on conflict (idempotency_key, action, resource, document_id) do nothing;
        else
          if v_data ? 'bb' and (
            nullif(v_data->>'bb', '') is null
            or (v_data->>'bb')::numeric < 0.1
            or (v_data->>'bb')::numeric > 60
          ) then
            raise exception 'Berat badan harus antara 0,1 sampai 60 kg.';
          end if;
          if v_data ? 'tb' and (
            nullif(v_data->>'tb', '') is null
            or (v_data->>'tb')::numeric < 10
            or (v_data->>'tb')::numeric > 220
          ) then
            raise exception 'Panjang atau tinggi badan harus antara 10 sampai 220 cm.';
          end if;
          if v_data ? 'lila' and (
            nullif(v_data->>'lila', '') is null
            or (v_data->>'lila')::numeric <= 0
            or (v_data->>'lila')::numeric > 50
          ) then
            raise exception 'LiLA harus antara 0,1 sampai 50 cm.';
          end if;
          if v_data ? 'lk' and (
            nullif(v_data->>'lk', '') is null
            or (v_data->>'lk')::numeric <= 0
            or (v_data->>'lk')::numeric > 80
          ) then
            raise exception 'Lingkar kepala harus antara 0,1 sampai 80 cm.';
          end if;
          if v_data ? 'statusNaik' and (v_data->>'statusNaik') not in ('N', 'T', 'B', 'O') then
            raise exception 'Status kenaikan berat badan tidak valid.';
          end if;

          update public.measurements
          set measurement_date = case when v_data ? 'tglUkur' then (v_data->>'tglUkur')::date else measurement_date end,
              measurement_date_raw = case when v_data ? 'tglUkur' then v_data->>'tglUkur' else measurement_date_raw end,
              weight_kg = case when v_data ? 'bb' then (v_data->>'bb')::numeric else weight_kg end,
              height_cm = case when v_data ? 'tb' then (v_data->>'tb')::numeric else height_cm end,
              head_circumference_cm = case when v_data ? 'lk' then (v_data->>'lk')::numeric else head_circumference_cm end,
              mid_upper_arm_circumference_cm = case when v_data ? 'lila' then (v_data->>'lila')::numeric else mid_upper_arm_circumference_cm end,
              edema = case when v_data ? 'edema' then v_data->>'edema' else edema end,
              mother_class_attendance = case when v_data ? 'kelasIbu' then v_data->>'kelasIbu' else mother_class_attendance end,
              mbg = case when v_data ? 'mbg' then v_data->>'mbg' else mbg end,
              vitamin_a = case when v_data ? 'vitA' then v_data->>'vitA' else vitamin_a end,
              exclusive_breastfeeding = case when v_data ? 'asi' then v_data->>'asi' else exclusive_breastfeeding end,
              measurement_method = case when v_data ? 'caraUkur' then v_data->>'caraUkur' else measurement_method end,
              weight_gain_status = case when v_data ? 'statusNaik' then v_data->>'statusNaik' else weight_gain_status end,
              age_in_months = case when v_data ? 'ageInMonths' then nullif(v_data->>'ageInMonths', '')::smallint else age_in_months end,
              updated_at = timezone('utc', now())
          where id = v_document_id;

          select measurement.* into strict v_measurement
          from public.measurements measurement
          where measurement.id = v_document_id;
          v_after := to_jsonb(v_measurement);
          delete from public.sync_tombstones
          where resource = 'measurements'
            and document_id = v_document_id;
          insert into public.audit_events (
            request_id, idempotency_key, actor_user_id, actor_role, action,
            resource, document_id, village, posyandu, before_data, after_data,
            metadata
          ) values (
            'direct-' || v_mutation_id, v_mutation_id, v_profile.user_id::text,
            v_profile.role, 'update', 'measurements', v_document_id,
            v_child.village, v_child.posyandu, v_before, v_after,
            jsonb_build_object('source', 'authenticated_measurement_fallback')
          ) on conflict (idempotency_key, action, resource, document_id) do nothing;
        end if;
      end if;

      if v_operation <> 'delete' then
        select jsonb_build_object(
          'id', measurement.id,
          'data', jsonb_build_object(
            'childId', coalesce(measurement.child_id, nullif(measurement.legacy_child_id, '')),
            'childName', measurement.legacy_child_name,
            'desa', measurement.legacy_village,
            'posyandu', measurement.legacy_posyandu,
            'tglUkur', measurement.measurement_date,
            'bb', measurement.weight_kg,
            'tb', measurement.height_cm,
            'lk', measurement.head_circumference_cm,
            'lila', measurement.mid_upper_arm_circumference_cm,
            'edema', measurement.edema,
            'kelasIbu', measurement.mother_class_attendance,
            'mbg', measurement.mbg,
            'vitA', measurement.vitamin_a,
            'asi', measurement.exclusive_breastfeeding,
            'caraUkur', measurement.measurement_method,
            'statusNaik', measurement.weight_gain_status,
            'ageInMonths', measurement.age_in_months,
            'createdAt', measurement.created_at,
            'updatedAt', measurement.updated_at,
            'version', measurement.version
          )
        ) into v_document
        from public.measurements measurement
        where measurement.id = v_document_id;
      end if;
    elsif v_resource = 'children' and v_operation = 'update' then
      if (
        v_data - array[
          'currentBB', 'currentTB', 'currentLILA', 'currentLK',
          'lastMeasurementDate', 'updatedAt'
        ]::text[]
      ) <> '{}'::jsonb then
        raise exception 'Hanya ringkasan pengukuran balita yang dapat diperbarui melalui jalur ini.';
      end if;

      select child.* into v_child
      from public.children child
      where child.id = v_document_id
        and child.deleted_at is null
      limit 1;
      if not found or not public.eposyandu_location_allowed(v_child.village, v_child.posyandu) then
        raise exception 'Data balita tidak ditemukan atau berada di luar wilayah akun.';
      end if;
      if v_data ? 'currentBB' and v_data->>'currentBB' is not null and (
        nullif(v_data->>'currentBB', '') is null
        or (v_data->>'currentBB')::numeric < 0.1
        or (v_data->>'currentBB')::numeric > 60
      ) then
        raise exception 'Ringkasan berat badan tidak valid.';
      end if;

      v_before := to_jsonb(v_child);
      update public.children
      set current_weight_kg = case when v_data ? 'currentBB' then nullif(v_data->>'currentBB', '')::numeric else current_weight_kg end,
          current_height_cm = case when v_data ? 'currentTB' then nullif(v_data->>'currentTB', '')::numeric else current_height_cm end,
          current_mid_upper_arm_circumference_cm = case when v_data ? 'currentLILA' then nullif(v_data->>'currentLILA', '')::numeric else current_mid_upper_arm_circumference_cm end,
          current_head_circumference_cm = case when v_data ? 'currentLK' then nullif(v_data->>'currentLK', '')::numeric else current_head_circumference_cm end,
          last_measurement_date = case when v_data ? 'lastMeasurementDate' then nullif(v_data->>'lastMeasurementDate', '')::date else last_measurement_date end,
          updated_at = timezone('utc', now())
      where id = v_document_id;

      select child.* into strict v_child from public.children child where child.id = v_document_id;
      v_after := to_jsonb(v_child);
      insert into public.audit_events (
        request_id, idempotency_key, actor_user_id, actor_role, action,
        resource, document_id, village, posyandu, before_data, after_data,
        metadata
      ) values (
        'direct-' || v_mutation_id, v_mutation_id, v_profile.user_id::text,
        v_profile.role, 'update', 'children', v_document_id,
        v_child.village, v_child.posyandu, v_before, v_after,
        jsonb_build_object('source', 'authenticated_measurement_fallback', 'summary_only', true)
      ) on conflict (idempotency_key, action, resource, document_id) do nothing;

      select public.eposyandu_self_child_detail(v_document_id) into v_document;
    else
      raise exception 'Jalur darurat hanya menerima perubahan penimbangan dan ringkasannya.';
    end if;

    v_results := v_results || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', v_mutation_id,
      'resource', v_resource,
      'documentId', v_document_id,
      'operation', v_operation,
      'document', v_document
    )));
  end loop;

  return jsonb_build_object(
    'results', v_results,
    'changes', '{}'::jsonb,
    'cursor', timezone('utc', now())
  );
end;
$$;

revoke all on function public.eposyandu_self_sync_measurement_batch(jsonb) from public, anon;
grant execute on function public.eposyandu_self_sync_measurement_batch(jsonb) to authenticated, service_role;

insert into public.schema_migrations (version, description)
values ('018', 'authenticated role-scoped measurement write fallback during edge API outages')
on conflict (version) do nothing;

commit;
