#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Isi DATABASE_URL dengan connection string PostgreSQL sumber.}"
command -v pg_dump >/dev/null 2>&1 || { echo "pg_dump belum terpasang." >&2; exit 1; }

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output="${1:-$root_dir/backups/e-posyandu-$timestamp.dump}"

umask 077
mkdir -p "$(dirname "$output")"
pg_dump "$DATABASE_URL" \
  --format=custom \
  --compress=9 \
  --no-owner \
  --no-acl \
  --file="$output"

printf 'Backup selesai: %s\n' "$output"
