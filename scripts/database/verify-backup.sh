#!/usr/bin/env bash
set -euo pipefail

backup_file="${1:?Berikan path file backup PostgreSQL format custom.}"
[[ -s "$backup_file" ]] || { echo "File backup kosong atau tidak ditemukan." >&2; exit 1; }
command -v pg_restore >/dev/null 2>&1 || { echo "pg_restore belum terpasang." >&2; exit 1; }

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT
pg_restore --list "$backup_file" > "$manifest"

for table in children measurements schema_migrations; do
  if ! grep -Eq "TABLE( DATA)? public ${table}( |$)" "$manifest"; then
    echo "Backup tidak memuat tabel wajib public.${table}." >&2
    exit 1
  fi
done

printf 'Backup terverifikasi: %s (%s byte)\n' "$backup_file" "$(wc -c < "$backup_file" | tr -d ' ')"
