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

pg_restore --dbname="$RESTORE_DATABASE_URL" \
  --schema=public \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  --exit-on-error \
  "$backup_file"

psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if to_regclass('public.children') is null then
    raise exception 'Tabel public.children tidak ditemukan setelah restore';
  end if;
  if to_regclass('public.measurements') is null then
    raise exception 'Tabel public.measurements tidak ditemukan setelah restore';
  end if;
  if to_regclass('public.schema_migrations') is null then
    raise exception 'Tabel public.schema_migrations tidak ditemukan setelah restore';
  end if;
  if not exists (select 1 from public.schema_migrations) then
    raise exception 'Riwayat migration kosong setelah restore';
  end if;
end
$$;
select count(*) as children_rows from public.children;
select count(*) as measurement_rows from public.measurements;
select max(version) as latest_migration from public.schema_migrations;
SQL

echo "Uji restore selesai pada database non-production."
