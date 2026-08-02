#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Isi DATABASE_URL dengan connection string PostgreSQL target.}"
command -v psql >/dev/null 2>&1 || { echo "psql belum terpasang." >&2; exit 1; }

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
migrations_dir="$root_dir/database/migrations"

for migration in "$migrations_dir"/[0-9][0-9][0-9]_*.sql; do
  version="$(basename "$migration" | cut -d_ -f1)"
  registry_exists="$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "select to_regclass('public.schema_migrations') is not null")"
  if [[ "$registry_exists" == "t" ]]; then
    applied="$(psql "$DATABASE_URL" -X -A -t -v ON_ERROR_STOP=1 -c "select exists(select 1 from public.schema_migrations where version = '$version')")"
    if [[ "$applied" == "t" ]]; then
      printf 'Lewati migration %s (sudah diterapkan).\n' "$version"
      continue
    fi
  fi

  printf 'Terapkan migration %s...\n' "$version"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$migration"
done

echo "Semua migration database sudah diterapkan."
