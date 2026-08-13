#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Isi SOURCE_DATABASE_URL dengan koneksi direct atau Session Pooler Supabase production.}"
: "${NEON_DATABASE_URL:?Isi NEON_DATABASE_URL dengan koneksi direct Neon milik owner.}"
: "${NEON_READER_DATABASE_URL:?Isi NEON_READER_DATABASE_URL dengan koneksi Neon role baca.}"

for command in psql python3; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s belum terpasang.\n' "$command" >&2
    exit 1
  }
done

count_tolerance="${REPLICA_COUNT_TOLERANCE:-25}"
max_lag_seconds="${REPLICA_MAX_LAG_SECONDS:-900}"
replicated_tables=(children measurements mpasi_logs eposyandu_growth_lms)

connection_field() {
  local connection="$1"
  local field="$2"
  CONNECTION_VALUE="$connection" CONNECTION_FIELD="$field" python3 <<'PY'
import os
from urllib.parse import unquote, urlsplit

parsed = urlsplit(os.environ["CONNECTION_VALUE"])
values = {
    "username": unquote(parsed.username or ""),
    "database": (parsed.path or "").lstrip("/"),
}
print(values[os.environ["CONNECTION_FIELD"]])
PY
}

if [[ ! "$count_tolerance" =~ ^[0-9]+$ || ! "$max_lag_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "REPLICA_COUNT_TOLERANCE dan REPLICA_MAX_LAG_SECONDS harus berupa angka positif." >&2
  exit 1
fi

reader_role="$(connection_field "$NEON_READER_DATABASE_URL" username)"
if [[ ! "$reader_role" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "Role pada NEON_READER_DATABASE_URL tidak valid." >&2
  exit 1
fi

count_details=()
for table in "${replicated_tables[@]}"; do
  source_count="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -c "select count(*) from public.\"$table\"")"
  target_count="$(psql "$NEON_READER_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -c "select count(*) from public.\"$table\"")"
  difference=$((source_count - target_count))
  (( difference < 0 )) && difference=$((-difference))
  count_details+=("$table=$source_count/$target_count")
  if (( difference > count_tolerance )); then
    printf 'Selisih public.%s terlalu besar: source=%s target=%s toleransi=%s.\n' \
      "$table" "$source_count" "$target_count" "$count_tolerance" >&2
    exit 1
  fi
done

state_count="$(psql "$NEON_READER_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL'
select count(*)
from public.eposyandu_replica_sync_state
where resource = any(array['children', 'measurements', 'mpasi_logs', 'sync_tombstones'])
  and last_success_at is not null;
SQL
)"
if [[ "$state_count" != "4" ]]; then
  echo "State sinkronisasi Neon belum lengkap." >&2
  exit 1
fi

lag_seconds="$(psql "$NEON_READER_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 <<'SQL'
select greatest(
  0,
  extract(epoch from (clock_timestamp() - min(last_success_at)))::bigint
)
from public.eposyandu_replica_sync_state;
SQL
)"
if (( lag_seconds > max_lag_seconds )); then
  printf 'Sinkronisasi Neon tertinggal %s detik (batas %s detik).\n' "$lag_seconds" "$max_lag_seconds" >&2
  exit 1
fi

for table in "${replicated_tables[@]}" eposyandu_replica_sync_state; do
  has_write="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -v reader_role="$reader_role" -v relation="public.$table" <<'SQL'
select has_table_privilege(:'reader_role', :'relation', 'INSERT')
  or has_table_privilege(:'reader_role', :'relation', 'UPDATE')
  or has_table_privilege(:'reader_role', :'relation', 'DELETE')
  or has_table_privilege(:'reader_role', :'relation', 'TRUNCATE');
SQL
)"
  if [[ "$has_write" == "t" ]]; then
    printf 'Role %s masih memiliki hak tulis pada public.%s.\n' "$reader_role" "$table" >&2
    exit 1
  fi
done

for signature in \
  'public.eposyandu_replica_apply_batch(text,jsonb)' \
  'public.eposyandu_replica_apply_tombstones(jsonb)'; do
  if [[ "$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -v reader_role="$reader_role" -v signature="$signature" <<'SQL'
select has_function_privilege(:'reader_role', :'signature', 'EXECUTE');
SQL
)" == "t" ]]; then
    printf 'Role %s tidak boleh menjalankan fungsi tulis %s.\n' "$reader_role" "$signature" >&2
    exit 1
  fi
done

read_only_setting="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -v reader_role="$reader_role" <<'SQL'
select coalesce(array_to_string(rolconfig, ','), '')
from pg_roles
where rolname = :'reader_role';
SQL
)"
if [[ "$read_only_setting" != *"default_transaction_read_only=on"* ]]; then
  printf 'Role %s belum memiliki default_transaction_read_only=on.\n' "$reader_role" >&2
  exit 1
fi

if [[ "$(psql "$NEON_READER_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "select public.eposyandu_dashboard_stats(current_date, current_date, current_date, current_date) is not null")" != "t" ]]; then
  echo "Fungsi laporan tidak dapat dijalankan memakai kredensial reader." >&2
  exit 1
fi

printf 'Read replica sehat, read-only, dan tertinggal %s detik: %s\n' \
  "$lag_seconds" "${count_details[*]}"
