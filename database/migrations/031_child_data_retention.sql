begin;

-- E-Posyandu adalah salinan operasional untuk pelaporan Sigizi-Kesga. Index
-- parsial ini membuat job retensi tidak perlu memindai baris yang masih aktif.
create index if not exists idx_children_recycle_retention
  on public.children (deleted_at)
  where deleted_at is not null;

create index if not exists idx_children_age_retention
  on public.children (birth_date)
  where deleted_at is null and birth_date is not null;

-- Hapus data secara atomik di primary. Recycle Bin disimpan 30 hari. Saat
-- balita mencapai 60 bulan, tanggal tersebut menjadi awal retensi kelulusan
-- lima tahun; data baru dihapus ketika tanggal lima tahun pasca-kelulusan
-- tercapai. Tombstone dipertahankan supaya read replica
-- menerima penghapusan fisik pada siklus sinkronisasi berikutnya.
create or replace function public.eposyandu_cleanup_retention(
  p_now timestamptz default clock_timestamp()
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(p_now, clock_timestamp());
  v_recycle_cutoff timestamptz := v_now - interval '30 days';
  v_post_graduation_cutoff date := ((v_now at time zone 'utc')::date - interval '5 years')::date;
  v_children bigint := 0;
  v_measurements bigint := 0;
  v_mpasi bigint := 0;
  v_pmt bigint := 0;
  v_change_logs bigint := 0;
  v_audit bigint := 0;
  v_tombstones bigint := 0;
begin
  -- Hanya satu instance job boleh menghapus data pada waktu yang sama.
  perform pg_advisory_xact_lock(hashtextextended('eposyandu:retention:v1', 0));

  create temporary table eposyandu_retention_children (
    id text primary key,
    village text,
    posyandu text
  ) on commit drop;

  insert into eposyandu_retention_children (id, village, posyandu)
  select c.id, c.village, c.posyandu
  from public.children c
  where (
      c.deleted_at is not null
      and c.deleted_at < v_recycle_cutoff
    )
    or (
      c.deleted_at is null
      and c.birth_date is not null
      and c.birth_date + interval '60 months' <= v_post_graduation_cutoff
    );

  if not exists (select 1 from eposyandu_retention_children) then
    return jsonb_build_object(
      'evaluatedAt', v_now,
      'recycleCutoff', v_recycle_cutoff,
      'postGraduationCutoff', v_post_graduation_cutoff,
      'children', 0,
      'measurements', 0,
      'mpasiLogs', 0,
      'pmtPrograms', 0,
      'changeLogs', 0,
      'auditEvents', 0,
      'tombstones', 0
    );
  end if;

  -- Tombstone anak dan seluruh data turunannya dibuat sebelum DELETE agar
  -- replika baca dapat membuang baris yang sama tanpa membaca data sensitif.
  insert into public.sync_tombstones (resource, document_id, village, posyandu, deleted_at)
  select 'children', c.id, c.village, c.posyandu, v_now
  from eposyandu_retention_children c
  on conflict (resource, document_id) do update
    set village = excluded.village,
        posyandu = excluded.posyandu,
        deleted_at = excluded.deleted_at;
  get diagnostics v_tombstones = row_count;

  insert into public.sync_tombstones (resource, document_id, village, posyandu, deleted_at)
  select distinct on (m.id)
    'measurements', m.id,
    coalesce(nullif(m.legacy_village, ''), c.village),
    coalesce(nullif(m.legacy_posyandu, ''), c.posyandu),
    v_now
  from public.measurements m
  left join public.children c on c.id = m.child_id
  where m.child_id in (select id from eposyandu_retention_children)
     or m.legacy_child_id in (select id from eposyandu_retention_children)
  on conflict (resource, document_id) do update
    set village = excluded.village,
        posyandu = excluded.posyandu,
        deleted_at = excluded.deleted_at;

  insert into public.sync_tombstones (resource, document_id, village, posyandu, deleted_at)
  select distinct on (m.id)
    'mpasi_logs', m.id,
    c.village,
    c.posyandu,
    v_now
  from public.mpasi_logs m
  left join public.children c on c.id = m.child_id
  where m.child_id in (select id from eposyandu_retention_children)
     or m.legacy_child_id in (select id from eposyandu_retention_children)
  on conflict (resource, document_id) do update
    set village = excluded.village,
        posyandu = excluded.posyandu,
        deleted_at = excluded.deleted_at;

  -- Audit payload dapat memuat identitas. Hapus sebelum baris sumber agar
  -- subquery masih dapat menemukan seluruh ID data turunannya.
  delete from public.audit_events a
  where (a.resource = 'children' and a.document_id in (select id from eposyandu_retention_children))
     or (a.resource = 'measurements' and a.document_id in (
       select m.id from public.measurements m
       where m.child_id in (select id from eposyandu_retention_children)
          or m.legacy_child_id in (select id from eposyandu_retention_children)
     ))
     or (a.resource = 'mpasi_logs' and a.document_id in (
       select m.id from public.mpasi_logs m
       where m.child_id in (select id from eposyandu_retention_children)
          or m.legacy_child_id in (select id from eposyandu_retention_children)
     ))
     or (a.resource = 'pmt_programs' and a.document_id in (
       select p.id from public.pmt_programs p
       where p.child_id in (select id from eposyandu_retention_children)
          or p.legacy_child_id in (select id from eposyandu_retention_children)
     ))
     or (a.resource = 'pmt_monitorings' and a.document_id in (
       select p.program_id::text from public.pmt_monitorings p
       where p.program_id in (
         select program.id from public.pmt_programs program
         where program.child_id in (select id from eposyandu_retention_children)
            or program.legacy_child_id in (select id from eposyandu_retention_children)
       )
     ))
     or (a.resource = 'change_logs' and a.document_id in (
       select l.id from public.change_logs l
       where l.child_id in (select id from eposyandu_retention_children)
          or l.legacy_child_id in (select id from eposyandu_retention_children)
     ));
  get diagnostics v_audit = row_count;

  -- Hapus relasi sebelum children karena FK legacy sengaja memakai SET NULL.
  delete from public.pmt_programs p
  where p.child_id in (select id from eposyandu_retention_children)
     or p.legacy_child_id in (select id from eposyandu_retention_children);
  get diagnostics v_pmt = row_count;

  delete from public.measurements m
  where m.child_id in (select id from eposyandu_retention_children)
     or m.legacy_child_id in (select id from eposyandu_retention_children);
  get diagnostics v_measurements = row_count;

  delete from public.mpasi_logs m
  where m.child_id in (select id from eposyandu_retention_children)
     or m.legacy_child_id in (select id from eposyandu_retention_children);
  get diagnostics v_mpasi = row_count;

  delete from public.change_logs l
  where l.child_id in (select id from eposyandu_retention_children)
     or l.legacy_child_id in (select id from eposyandu_retention_children);
  get diagnostics v_change_logs = row_count;

  delete from public.children c
  where c.id in (select id from eposyandu_retention_children);
  get diagnostics v_children = row_count;

  return jsonb_build_object(
    'evaluatedAt', v_now,
    'recycleCutoff', v_recycle_cutoff,
    'postGraduationCutoff', v_post_graduation_cutoff,
    'children', v_children,
    'measurements', v_measurements,
    'mpasiLogs', v_mpasi,
    'pmtPrograms', v_pmt,
    'changeLogs', v_change_logs,
    'auditEvents', v_audit,
    'tombstones', v_tombstones
  );
end;
$$;

revoke all on function public.eposyandu_cleanup_retention(timestamptz) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.eposyandu_cleanup_retention(timestamptz) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.eposyandu_cleanup_retention(timestamptz) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.eposyandu_cleanup_retention(timestamptz) to service_role';
  end if;
end
$$;

insert into public.schema_migrations (version, description)
values ('031', 'child recycle bin and five-year operational retention')
on conflict (version) do nothing;

commit;
