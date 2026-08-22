#!/bin/sh
set -eu

required_files="${STANDBY_SOURCE_URL_FILE} ${STANDBY_OWNER_PASSWORD_FILE} ${STANDBY_READER_PASSWORD_FILE}"
for required_file in $required_files; do
  if [ ! -s "$required_file" ]; then
    echo "Secret runtime standby tidak tersedia: $required_file" >&2
    exit 1
  fi
done

source_url="$(cat "$STANDBY_SOURCE_URL_FILE")"
owner_password="$(cat "$STANDBY_OWNER_PASSWORD_FILE")"
reader_password="$(cat "$STANDBY_READER_PASSWORD_FILE")"
target_owner_url="postgresql://${STANDBY_TARGET_OWNER}@${STANDBY_TARGET_HOST}:5432/${STANDBY_TARGET_DB}"
target_reader_url="postgresql://${STANDBY_TARGET_READER}@${STANDBY_TARGET_HOST}:5432/${STANDBY_TARGET_DB}"

case "$source_url" in
  postgresql://*|postgres://*) ;;
  *)
    echo "Secret source database bukan URL PostgreSQL." >&2
    exit 1
    ;;
esac

for attempt in $(seq 1 30); do
  if PGPASSWORD="$owner_password" pg_isready \
    --host "$STANDBY_TARGET_HOST" \
    --username "$STANDBY_TARGET_OWNER" \
    --dbname "$STANDBY_TARGET_DB" >/dev/null 2>&1; then
    break
  fi
  if [ "$attempt" -eq 30 ]; then
    echo "PostgreSQL standby belum sehat setelah 60 detik." >&2
    exit 1
  fi
  sleep 2
done

verify_read_only() {
  read_only_setting="$(PGPASSWORD="$reader_password" psql "$target_reader_url" \
    -X -A -t --set ON_ERROR_STOP=1 -c 'show transaction_read_only')"
  if [ "$read_only_setting" != "on" ]; then
    echo "Role reader standby belum dipaksa read-only." >&2
    exit 1
  fi

  PGPASSWORD="$owner_password" psql "$target_owner_url" \
    -X -A -t --set ON_ERROR_STOP=1 \
    --set reader_role="$STANDBY_TARGET_READER" <<'SQL' | grep -qx 'f'
select bool_or(
  has_table_privilege(:'reader_role', format('public.%I', table_name), 'INSERT')
  or has_table_privilege(:'reader_role', format('public.%I', table_name), 'UPDATE')
  or has_table_privilege(:'reader_role', format('public.%I', table_name), 'DELETE')
  or has_table_privilege(:'reader_role', format('public.%I', table_name), 'TRUNCATE')
)
from information_schema.tables
where table_schema = 'public';
SQL

  PGPASSWORD="$owner_password" psql "$target_owner_url" \
    -X -A -t --set ON_ERROR_STOP=1 <<'SQL'
select format('%s=%s', table_name, row_count)
from (
  select 'children' as table_name, count(*) as row_count from public.children
  union all
  select 'measurements', count(*) from public.measurements
  union all
  select 'mpasi_logs', count(*) from public.mpasi_logs
  union all
  select 'eposyandu_growth_lms', count(*) from public.eposyandu_growth_lms
) counts
order by table_name;
SQL
}

if [ "${STANDBY_ACTION:-sync}" = "verify" ]; then
  verify_read_only
  echo "PostgreSQL standby Oracle sehat dan read-only."
  exit 0
fi

temporary_dir="$(mktemp -d /tmp/eposyandu-standby.XXXXXX)"
trap 'rm -rf "$temporary_dir"; unset source_url owner_password reader_password' EXIT HUP INT TERM
dump_file="$temporary_dir/standby.dump"
restore_list="$temporary_dir/standby.restore-list"

echo "Membuat snapshot empat tabel replika dari database primary..."
pg_dump "$source_url" \
  --format=custom \
  --no-owner \
  --no-acl \
  --table=public.children \
  --table=public.measurements \
  --table=public.mpasi_logs \
  --table=public.eposyandu_growth_lms \
  --file="$dump_file"

# A read-only snapshot must not execute source-side mutation triggers or copy
# Supabase RLS policies whose helper functions are intentionally absent here.
# Indexes, constraints, table definitions, and table data remain in the TOC.
pg_restore --list "$dump_file" \
  | grep -Ev ' (TRIGGER|POLICY|ROW SECURITY) ' \
  > "$restore_list"

echo "Mengganti snapshot PostgreSQL standby Oracle..."
PGPASSWORD="$owner_password" pg_restore \
  --clean \
  --if-exists \
  --single-transaction \
  --no-owner \
  --no-acl \
  --exit-on-error \
  --use-list="$restore_list" \
  --dbname="$target_owner_url" \
  "$dump_file"

PGPASSWORD="$owner_password" psql "$target_owner_url" \
  -X --set ON_ERROR_STOP=1 \
  --set reader_role="$STANDBY_TARGET_READER" <<'SQL' >/dev/null
revoke create on schema public from public;
revoke all on all tables in schema public from public;
revoke all on all tables in schema public from :"reader_role";
grant usage on schema public to :"reader_role";
grant select on table
  public.children,
  public.measurements,
  public.mpasi_logs,
  public.eposyandu_growth_lms
to :"reader_role";

create schema if not exists standby_meta;
create table if not exists standby_meta.sync_state (
  singleton boolean primary key default true check (singleton),
  last_success_at timestamptz not null,
  source text not null,
  replicated_tables integer not null
);
insert into standby_meta.sync_state(singleton, last_success_at, source, replicated_tables)
values (true, clock_timestamp(), 'supabase-primary', 4)
on conflict (singleton) do update
set last_success_at = excluded.last_success_at,
    source = excluded.source,
    replicated_tables = excluded.replicated_tables;
revoke all on schema standby_meta from public;
revoke all on table standby_meta.sync_state from public;
grant usage on schema standby_meta to :"reader_role";
grant select on table standby_meta.sync_state to :"reader_role";
alter role :"reader_role" set default_transaction_read_only = on;
SQL

verify_read_only
echo "Snapshot PostgreSQL standby Oracle selesai."
