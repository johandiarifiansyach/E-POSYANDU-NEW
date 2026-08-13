#!/usr/bin/env bash
set -euo pipefail

: "${SOURCE_DATABASE_URL:?Isi SOURCE_DATABASE_URL dengan koneksi direct Supabase production.}"
: "${NEON_DATABASE_URL:?Isi NEON_DATABASE_URL dengan koneksi direct Neon milik owner.}"
: "${NEON_READER_DATABASE_URL:?Isi NEON_READER_DATABASE_URL dengan koneksi Neon role baca.}"

for command in psql python3; do
  command -v "$command" >/dev/null 2>&1 || {
    printf '%s belum terpasang.\n' "$command" >&2
    exit 1
  }
done

publication="${REPLICA_PUBLICATION:-eposyandu_neon_read_pub}"
slot="${REPLICA_SLOT:-eposyandu_neon_read_slot}"
subscription="${REPLICA_SUBSCRIPTION:-eposyandu_supabase_read_sub}"
wait_seconds="${REPLICA_WAIT_SECONDS:-0}"
poll_seconds="${REPLICA_POLL_SECONDS:-5}"
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

if [[ ! "$wait_seconds" =~ ^[0-9]+$ || ! "$poll_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "REPLICA_WAIT_SECONDS dan REPLICA_POLL_SECONDS harus berupa detik positif." >&2
  exit 1
fi

reader_role="$(connection_field "$NEON_READER_DATABASE_URL" username)"
validate_identifier "REPLICA_PUBLICATION" "$publication"
validate_identifier "REPLICA_SLOT" "$slot"
validate_identifier "REPLICA_SUBSCRIPTION" "$subscription"
validate_identifier "Role NEON_READER_DATABASE_URL" "$reader_role"
deadline=$((SECONDS + wait_seconds))
last_detail=""

while true; do
  publication_tables="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -v publication="$publication" <<'SQL'
select count(*)
from pg_publication_tables
where pubname = :'publication'
  and schemaname = 'public'
  and tablename = any(array['children','measurements','mpasi_logs','eposyandu_growth_lms']);
SQL
)"
  slot_active="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -v slot="$slot" <<'SQL'
select coalesce((select active from pg_replication_slots where slot_name = :'slot'), false);
SQL
)"
  subscription_ready="$(psql "$NEON_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
    -v subscription="$subscription" <<'SQL'
select exists(
  select 1 from pg_stat_subscription where subname = :'subscription' and pid is not null
) and not exists(
  select 1
  from pg_subscription_rel
  where srsubid = (select oid from pg_subscription where subname = :'subscription')
    and srsubstate <> 'r'
);
SQL
)"

  counts_match=true
  count_details=()
  for table in "${replicated_tables[@]}"; do
    source_count="$(psql "$SOURCE_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
      -c "select count(*) from public.\"$table\"")"
    target_count="$(psql "$NEON_READER_DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 \
      -c "select count(*) from public.\"$table\"")"
    count_details+=("$table=$source_count/$target_count")
    if [[ "$source_count" != "$target_count" ]]; then
      counts_match=false
    fi
  done

  last_detail="publication=$publication_tables/4 slot_active=$slot_active subscription_ready=$subscription_ready counts=${count_details[*]}"
  if [[ "$publication_tables" == "4" && "$slot_active" == "t" && "$subscription_ready" == "t" && "$counts_match" == "true" ]]; then
    break
  fi
  if (( SECONDS >= deadline )); then
    printf 'Read replica belum konsisten: %s\n' "$last_detail" >&2
    exit 1
  fi
  printf 'Menunggu replikasi: %s\n' "$last_detail"
  sleep "$poll_seconds"
done

for table in "${replicated_tables[@]}"; do
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

printf 'Read replica sehat dan read-only: %s\n' "$last_detail"
