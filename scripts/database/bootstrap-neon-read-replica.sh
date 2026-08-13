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

publication="${REPLICA_PUBLICATION:-eposyandu_neon_read_pub}"
slot="${REPLICA_SLOT:-eposyandu_neon_read_slot}"
subscription="${REPLICA_SUBSCRIPTION:-eposyandu_supabase_read_sub}"
allow_existing_schema="${REPLICA_ALLOW_EXISTING_SCHEMA:-false}"
root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
temporary_dir="$(mktemp -d)"
replication_started=false
completed=false

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
    "port": str(parsed.port or 5432),
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
    printf '%s harus memakai koneksi direct, bukan pooler: %s\n' "$label" "$host" >&2
    exit 1
  fi
}

cleanup() {
  local exit_code=$?
  rm -rf "$temporary_dir"
  if [[ "$completed" != "true" && "$replication_started" == "true" ]]; then
    echo "Aktivasi gagal; membersihkan publication, slot, dan subscription yang baru dibuat." >&2
    set +e
    if [[ "$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
      -v subscription="$subscription" \
      -c "select exists(select 1 from pg_subscription where subname = :'subscription')")" == "t" ]]; then
      psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
        -c "alter subscription \"$subscription\" disable" >/dev/null
      psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
        -c "alter subscription \"$subscription\" set (slot_name = none)" >/dev/null
      psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
        -c "drop subscription \"$subscription\"" >/dev/null
    fi
    psql "$SOURCE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v slot="$slot" <<'SQL' >/dev/null
select pg_drop_replication_slot(:'slot')
where exists (
  select 1 from pg_replication_slots where slot_name = :'slot' and not active
);
SQL
    psql "$SOURCE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
      -c "drop publication if exists \"$publication\"" >/dev/null
    set -e
  fi
  exit "$exit_code"
}
trap cleanup EXIT

validate_identifier "REPLICA_PUBLICATION" "$publication"
validate_identifier "REPLICA_SLOT" "$slot"
validate_identifier "REPLICA_SUBSCRIPTION" "$subscription"
validate_connection "SOURCE_DATABASE_URL" "$SOURCE_DATABASE_URL" false
validate_connection "NEON_DATABASE_URL" "$NEON_DATABASE_URL" false
validate_connection "NEON_READER_DATABASE_URL" "$NEON_READER_DATABASE_URL" true

source_host="$(connection_field "$SOURCE_DATABASE_URL" host)"
target_host="$(connection_field "$NEON_DATABASE_URL" host)"
target_database="$(connection_field "$NEON_DATABASE_URL" database)"
reader_host="$(connection_field "$NEON_READER_DATABASE_URL" host)"
reader_database="$(connection_field "$NEON_READER_DATABASE_URL" database)"
reader_role="$(connection_field "$NEON_READER_DATABASE_URL" username)"

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

echo "Memeriksa migration dan resource replikasi..."
if [[ "$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "select exists(select 1 from public.schema_migrations where version = '020')")" != "t" ]]; then
  echo "Migration 020 belum diterapkan pada Supabase production." >&2
  exit 1
fi

source_conflict="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -v publication="$publication" -v slot="$slot" \
  -c "select exists(select 1 from pg_publication where pubname = :'publication') or exists(select 1 from pg_replication_slots where slot_name = :'slot')")"
target_conflict="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -v subscription="$subscription" \
  -c "select exists(select 1 from pg_subscription where subname = :'subscription')")"
if [[ "$source_conflict" == "t" || "$target_conflict" == "t" ]]; then
  echo "Resource replikasi sudah ada. Jalankan npm run replica:verify, jangan membuatnya dua kali." >&2
  exit 1
fi

target_has_tables="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "select to_regclass('public.children') is not null")"
if [[ "$target_has_tables" == "t" && "$allow_existing_schema" != "true" ]]; then
  echo "Schema target sudah berisi tabel children. Gunakan database/branch Neon kosong atau set REPLICA_ALLOW_EXISTING_SCHEMA=true setelah memeriksa isinya." >&2
  exit 1
fi

if [[ "$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -v reader_role="$reader_role" \
  -c "select exists(select 1 from pg_roles where rolname = :'reader_role')")" != "t" ]]; then
  printf 'Role Neon %s belum ada. Buat role login khusus baca terlebih dahulu.\n' "$reader_role" >&2
  exit 1
fi

if [[ "$target_has_tables" != "t" ]]; then
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

echo "Mengunci kredensial Worker Neon menjadi read-only..."
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 -v reader_role="$reader_role" <<'SQL' >/dev/null
revoke create on schema public from public;
grant usage on schema public to :"reader_role";
revoke all on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms
from public;
revoke all on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms
from :"reader_role";
grant select on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms
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
alter role :"reader_role" set default_transaction_read_only = on;
SQL

echo "Membuat publication dan logical replication slot pada Supabase..."
psql "$SOURCE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v publication="$publication" -v slot="$slot" <<'SQL' >/dev/null
create publication :"publication" for table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms;
select pg_create_logical_replication_slot(:'slot', 'pgoutput');
SQL
replication_started=true

echo "Membuat subscription pada Neon..."
psql "$NEON_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -v subscription="$subscription" \
  -v publication="$publication" \
  -v slot="$slot" \
  -v source_database_url="$SOURCE_DATABASE_URL" <<'SQL' >/dev/null
create subscription :"subscription"
connection :'source_database_url'
publication :"publication"
with (
  create_slot = false,
  enabled = true,
  slot_name = :'slot',
  copy_data = true,
  streaming = on
);
SQL

completed=true
echo "Replikasi dibuat. Menunggu salinan awal dan memverifikasi keamanan..."
SOURCE_DATABASE_URL="$SOURCE_DATABASE_URL" \
NEON_DATABASE_URL="$NEON_DATABASE_URL" \
NEON_READER_DATABASE_URL="$NEON_READER_DATABASE_URL" \
REPLICA_PUBLICATION="$publication" \
REPLICA_SLOT="$slot" \
REPLICA_SUBSCRIPTION="$subscription" \
REPLICA_WAIT_SECONDS="${REPLICA_WAIT_SECONDS:-600}" \
  "$root_dir/scripts/database/verify-neon-read-replica.sh"

echo "Supabase primary dan Neon read replica sudah aktif."
