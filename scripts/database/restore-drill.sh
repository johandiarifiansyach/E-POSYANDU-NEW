#!/usr/bin/env bash
set -euo pipefail

: "${RESTORE_DATABASE_URL:?Isi RESTORE_DATABASE_URL dengan database khusus uji restore.}"
: "${CONFIRM_RESTORE_DRILL:?Isi CONFIRM_RESTORE_DRILL=RESTORE-TEST untuk mengizinkan penghapusan database target.}"

if [[ "$CONFIRM_RESTORE_DRILL" != "RESTORE-TEST" ]]; then
  echo "Konfirmasi uji restore tidak sesuai." >&2
  exit 1
fi
if [[ -n "${DATABASE_URL:-}" && "$RESTORE_DATABASE_URL" == "$DATABASE_URL" ]]; then
  echo "Target restore tidak boleh sama dengan DATABASE_URL sumber/production." >&2
  exit 1
fi

backup_file="${1:?Berikan path file .dump yang akan diuji.}"
[[ -f "$backup_file" ]] || { echo "File backup tidak ditemukan." >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore belum terpasang." >&2; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "psql belum terpasang." >&2; exit 1; }

pg_restore "$RESTORE_DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "$backup_file"

psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
select to_regclass('public.children') is not null as children_ready;
select to_regclass('public.measurements') is not null as measurements_ready;
select max(version) as latest_migration from public.schema_migrations;
SQL

echo "Uji restore selesai pada database non-production."
