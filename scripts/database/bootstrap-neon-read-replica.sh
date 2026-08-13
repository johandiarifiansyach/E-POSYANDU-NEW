#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Isi SOURCE_DATABASE_URL dengan koneksi direct Supabase production.}"
: "${NEON_DATABASE_URL:?Isi NEON_DATABASE_URL dengan koneksi direct Neon milik owner.}"
: "${NEON_READER_DATABASE_URL:?Isi NEON_READER_DATABASE_URL dengan koneksi Neon role baca.}"

for command in psql pg_dump pg_restore python3; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s belum terpasang.\n' "$command" >&2
    exit 1
  }
done

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT

replicated_tables=(children measurements mpasi_logs eposyandu_growth_lms)

validate_identifier() {
  local label="$1"
  local value="$2"
  if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
    printf '%s tidak valid: hanya huruf, angka, dan garis bawah yang diizinkan.\n' "$label" >&2
    exit 1
  fi
}

connection_field() {
  local connection="$1"
  local field="$2"
  CONNECTION_VALUE="$connection" CONNECTION_FIELD="$field" python3 <<'PY'
import os
from urllib.parse import unquote, urlsplit

parsed = urlsplit(os.environ["CONNECTION_VALUE"])
field = os.environ["CONNECTION_FIELD"]
values = {
    "host": parsed.hostname or "",
    "username": unquote(parsed.username or ""),
    "database": (parsed.path or "").lstrip("/"),
}
print(values[field])
PY
}

validate_connection() {
  local label="$1"
  local connection="$2"
  local allow_pooler="$3"
  local host username database
  host="$(connection_field "$connection" host)"
  username="$(connection_field "$connection" username)"
  database="$(connection_field "$connection" database)"
  if [[ -z "$host" || -z "$username" || -z "$database" ]]; then
    printf '%s bukan connection string PostgreSQL yang lengkap.\n' "$label" >&2
    exit 1
  fi
  if [[ "$allow_pooler" != "true" && "$host" == *pooler* ]]; then
    printf '%s harus memakai koneksi direct untuk proses snapshot: %s\n' "$label" "$host" >&2
    exit 1
  fi
}

validate_connection "SOURCE_DATABASE_URL" "$SOURCE_DATABASE_URL" false
validate_connection "NEON_DATABASE_URL" "$NEON_DATABASE_URL" false
validate_connection "NEON_READER_DATABASE_URL" "$NEON_READER_DATABASE_URL" true

source_host="$(connection_field "$SOURCE_DATABASE_URL" host)"
target_host="$(connection_field "$NEON_DATABASE_URL" host)"
target_database="$(connection_field "$NEON_DATABASE_URL" database)"
reader_host="$(connection_field "$NEON_READER_DATABASE_URL" host)"
reader_database="$(connection_field "$NEON_READER_DATABASE_URL" database)"
reader_role="$(connection_field "$NEON_READER_DATABASE_URL" username)"
validate_identifier "Role NEON_READER_DATABASE_URL" "$reader_role"

if [[ "$source_host" == "$target_host" ]]; then
  echo "Supabase source dan Neon target tidak boleh menunjuk host yang sama." >&2
  exit 1
fi
if [[ "$target_database" != "$reader_database" ]]; then
  echo "NEON_DATABASE_URL dan NEON_READER_DATABASE_URL harus menunjuk database yang sama." >&2
  exit 1
fi
if [[ "${target_host/-pooler/}" != "${reader_host/-pooler/}" ]]; then
  echo "NEON_DATABASE_URL dan NEON_READER_DATABASE_URL harus menunjuk endpoint Neon yang sama." >&2
  exit 1
fi

echo "Memeriksa migration dan role Neon..."
if [[ "$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "select exists(select 1 from public.schema_migrations where version = '020')")" != "t" ]]; then
  echo "Migration 020 belum diterapkan pada Supabase production." >&2
  exit 1
fi
if [[ "$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -v reader_role="$reader_role" <<'SQL'
select exists(select 1 from pg_roles where rolname = :'reader_role');
SQL
)" != "t" ]]; then
  printf 'Role Neon %s belum ada. Buat role login khusus baca terlebih dahulu.\n' "$reader_role" >&2
  exit 1
fi

target_table_count="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL'
select count(*)
from (values
  (to_regclass('public.children')),
  (to_regclass('public.measurements')),
  (to_regclass('public.mpasi_logs')),
  (to_regclass('public.eposyandu_growth_lms'))
) tables(relation)
where relation is not null;
SQL
)"
if [[ "$target_table_count" != "0" && "$target_table_count" != "4" ]]; then
  echo "Schema Neon hanya berisi sebagian tabel replika. Bersihkan branch Neon lalu ulangi aktivasi." >&2
  exit 1
fi

snapshot_started_at="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "select clock_timestamp()")"

if [[ "$target_table_count" == "0" ]]; then
  echo "Menyalin struktur empat tabel baca ke Neon..."
  pg_dump "$SOURCE_DATABASE_URL" \
    --format=custom \
    --schema-only \
    --no-owner \
    --no-acl \
    --table=public.children \
    --table=public.measurements \
    --table=public.mpasi_logs \
    --table=public.eposyandu_growth_lms \
    --file="$temporary_dir/replica-schema.dump"
  pg_restore \
    --section=pre-data \
    --no-owner \
    --no-acl \
    --exit-on-error \
    --dbname="$NEON_DATABASE_URL" \
    "$temporary_dir/replica-schema.dump"
else
  echo "Empat tabel Neon sudah ada; struktur dipakai ulang secara idempoten."
fi

echo "Menyelaraskan index dan fungsi laporan pada Neon..."
psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL' \
  | sed -E \
      -e 's/^CREATE UNIQUE INDEX /CREATE UNIQUE INDEX IF NOT EXISTS /' \
      -e 's/^CREATE INDEX /CREATE INDEX IF NOT EXISTS /' \
  > "$temporary_dir/indexes.sql"
select pg_get_indexdef(indexrelid) || ';'
from pg_index
where indrelid in (
  'public.children'::regclass,
  'public.measurements'::regclass,
  'public.mpasi_logs'::regclass,
  'public.eposyandu_growth_lms'::regclass
)
order by indisprimary desc, indexrelid::regclass::text;
SQL
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$temporary_dir/indexes.sql" >/dev/null

psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 > "$temporary_dir/functions.sql" <<'SQL'
select pg_get_functiondef(functions.oid) || E';\n'
from pg_proc functions
join pg_namespace namespaces on namespaces.oid = functions.pronamespace
where namespaces.nspname = 'public'
  and functions.proname = any(array[
    'eposyandu_lms',
    'eposyandu_zscore',
    'eposyandu_adjusted_height',
    'eposyandu_growth_status',
    'eposyandu_age_months',
    'eposyandu_scope_match',
    'eposyandu_exclusive_breastfeeding_page',
    'eposyandu_problem_children_page',
    'eposyandu_dashboard_stats',
    'eposyandu_sigizi_measurement_export',
    'eposyandu_replica_children_page'
  ])
order by array_position(array[
  'eposyandu_lms',
  'eposyandu_zscore',
  'eposyandu_adjusted_height',
  'eposyandu_growth_status',
  'eposyandu_age_months',
  'eposyandu_scope_match',
  'eposyandu_exclusive_breastfeeding_page',
  'eposyandu_problem_children_page',
  'eposyandu_dashboard_stats',
  'eposyandu_sigizi_measurement_export',
  'eposyandu_replica_children_page'
], functions.proname), functions.oid;
SQL
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$temporary_dir/functions.sql" >/dev/null

echo "Membuat snapshot awal melalui koneksi lokal..."
pg_dump "$SOURCE_DATABASE_URL" \
  --format=custom \
  --data-only \
  --no-owner \
  --no-acl \
  --table=public.children \
  --table=public.measurements \
  --table=public.mpasi_logs \
  --table=public.eposyandu_growth_lms \
  --file="$temporary_dir/replica-data.dump"
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
truncate table
  public.measurements,
  public.mpasi_logs,
  public.children,
  public.eposyandu_growth_lms;
SQL
pg_restore \
  --data-only \
  --no-owner \
  --no-acl \
  --exit-on-error \
  --dbname="$NEON_DATABASE_URL" \
  "$temporary_dir/replica-data.dump"

echo "Menyiapkan state dan fungsi sinkronisasi inkremental Neon..."
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v snapshot_started_at="$snapshot_started_at" <<'SQL' >/dev/null
create table if not exists public.eposyandu_replica_sync_state (
  resource text primary key,
  cursor_at timestamptz not null,
  last_success_at timestamptz,
  last_row_count integer not null default 0,
  last_error text,
  updated_at timestamptz not null default clock_timestamp()
);

create or replace function public.eposyandu_replica_apply_batch(
  p_table text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_update_set text;
  v_count integer;
begin
  if p_table not in ('children', 'measurements', 'mpasi_logs') then
    raise exception 'Replica table is not allowed';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Replica rows must be a JSON array';
  end if;

  v_count := jsonb_array_length(p_rows);
  if v_count = 0 then
    return 0;
  end if;

  select string_agg(format('%1$I = excluded.%1$I', attributes.attname), ', ' order by attributes.attnum)
  into v_update_set
  from pg_attribute attributes
  where attributes.attrelid = format('public.%I', p_table)::regclass
    and attributes.attnum > 0
    and not attributes.attisdropped
    and attributes.attgenerated = ''
    and attributes.attname <> 'id';

  execute format(
    'insert into public.%1$I select * from jsonb_populate_recordset(null::public.%1$I, $1) '
      || 'on conflict (id) do update set %2$s',
    p_table,
    v_update_set
  ) using p_rows;
  return v_count;
end;
$$;

create or replace function public.eposyandu_replica_apply_tombstones(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_deleted integer;
  v_total integer := 0;
begin
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Replica tombstones must be a JSON array';
  end if;

  for v_table in
    select distinct records.resource
    from jsonb_to_recordset(p_rows) as records(resource text, document_id text)
  loop
    if v_table not in ('children', 'measurements', 'mpasi_logs') then
      raise exception 'Replica tombstone resource is not allowed';
    end if;
    execute format(
      'delete from public.%I target using jsonb_to_recordset($1) '
        || 'as records(resource text, document_id text) '
        || 'where records.resource = $2 and target.id = records.document_id',
      v_table
    ) using p_rows, v_table;
    get diagnostics v_deleted = row_count;
    v_total := v_total + v_deleted;
  end loop;
  return v_total;
end;
$$;

insert into public.eposyandu_replica_sync_state (
  resource,
  cursor_at,
  last_success_at,
  last_row_count,
  last_error,
  updated_at
)
select resource, :'snapshot_started_at'::timestamptz - interval '5 seconds', clock_timestamp(), 0, null, clock_timestamp()
from unnest(array['children', 'measurements', 'mpasi_logs', 'sync_tombstones']) resources(resource)
on conflict (resource) do update
set cursor_at = excluded.cursor_at,
    last_success_at = excluded.last_success_at,
    last_row_count = 0,
    last_error = null,
    updated_at = excluded.updated_at;

revoke all on function public.eposyandu_replica_apply_batch(text, jsonb) from public;
revoke all on function public.eposyandu_replica_apply_tombstones(jsonb) from public;
SQL

echo "Mengunci kredensial Worker Neon menjadi read-only..."
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v reader_role="$reader_role" <<'SQL' >/dev/null
revoke create on schema public from public;
grant usage on schema public to :"reader_role";
revoke all on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms,
  public.eposyandu_replica_sync_state
from public;
revoke all on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms,
  public.eposyandu_replica_sync_state
from :"reader_role";
grant select on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms,
  public.eposyandu_replica_sync_state
to :"reader_role";
select format(
  'revoke all on function %s from public; revoke all on function %s from %I; grant execute on function %s to %I;',
  functions.oid::regprocedure,
  functions.oid::regprocedure,
  :'reader_role',
  functions.oid::regprocedure,
  :'reader_role'
)
from pg_proc functions
join pg_namespace namespaces on namespaces.oid = functions.pronamespace
where namespaces.nspname = 'public'
  and functions.proname = any(array[
    'eposyandu_lms',
    'eposyandu_zscore',
    'eposyandu_adjusted_height',
    'eposyandu_growth_status',
    'eposyandu_age_months',
    'eposyandu_scope_match',
    'eposyandu_exclusive_breastfeeding_page',
    'eposyandu_problem_children_page',
    'eposyandu_dashboard_stats',
    'eposyandu_sigizi_measurement_export',
    'eposyandu_replica_children_page'
  ])
\gexec
revoke all on function public.eposyandu_replica_apply_batch(text, jsonb) from :"reader_role";
revoke all on function public.eposyandu_replica_apply_tombstones(jsonb) from :"reader_role";
alter role :"reader_role" set default_transaction_read_only = on;
SQL

echo "Snapshot selesai. Memverifikasi data dan keamanan Neon..."
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
NEON_DATABASE_URL="$NEON_DATABASE_URL" \
NEON_READER_DATABASE_URL="$NEON_READER_DATABASE_URL" \
  "$root_dir/scripts/database/verify-neon-read-replica.sh"

echo "Snapshot Neon aktif. Deploy private Worker agar perubahan berikutnya tersinkron lewat HTTPS."
