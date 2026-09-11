#!/usr/bin/env bash
set -euo pipefail

# Keep the native application role from exhausting PostgreSQL's global
# connection budget.  The role limit is managed locally as postgres because
# the application role intentionally does not have CREATEROLE privileges.
# Never lower an existing higher limit (or an unlimited role).

env_file="${1:-/etc/e-posyandu/nutrition-grpc.env}"
role="eposyandu_api"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Pengaturan budget koneksi PostgreSQL harus dijalankan sebagai root." >&2
  exit 1
fi

if [[ ! -r "$env_file" ]]; then
  echo "File env PostgreSQL tidak ditemukan: $env_file" >&2
  exit 1
fi
if ! command -v runuser >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "runuser dan psql wajib tersedia untuk mengatur budget koneksi PostgreSQL." >&2
  exit 1
fi
if ! id postgres >/dev/null 2>&1; then
  echo "User sistem postgres belum tersedia; budget koneksi belum dapat diperiksa." >&2
  exit 1
fi

target="$(sed -n 's/^ORACLE_POSTGRES_API_ROLE_CONNECTION_LIMIT=//p' "$env_file" | tail -n 1)"
target="${target:-40}"
if [[ ! "$target" =~ ^[0-9]+$ ]] || (( target < 10 || target > 90 )); then
  echo "ORACLE_POSTGRES_API_ROLE_CONNECTION_LIMIT harus berupa angka 10..90." >&2
  exit 1
fi

psql_local() {
  runuser -u postgres -- psql \
    --dbname=postgres \
    --no-psqlrc \
    --set=ON_ERROR_STOP=1 \
    --tuples-only \
    --no-align \
    "$@"
}

role_limit="$(psql_local --command="select rolconnlimit from pg_roles where rolname='$role';")"
role_limit="${role_limit//[[:space:]]/}"
if [[ -z "$role_limit" ]]; then
  echo "Role $role belum ada; budget koneksi dilewati sampai role dibuat." >&2
  exit 0
fi
if [[ ! "$role_limit" =~ ^-?[0-9]+$ ]]; then
  echo "Nilai rolconnlimit untuk $role tidak valid." >&2
  exit 1
fi

if (( role_limit == -1 || role_limit >= target )); then
  echo "Budget koneksi PostgreSQL: $role sudah $role_limit (target minimum $target)."
  exit 0
fi

# Leave at least five slots for postgres maintenance, backups, and emergency
# access.  An unlimited role is deliberately preserved as-is.
max_connections="$(psql_local --command='show max_connections;')"
max_connections="${max_connections//[[:space:]]/}"
if [[ ! "$max_connections" =~ ^[0-9]+$ ]] || (( target >= max_connections - 4 )); then
  echo "Budget koneksi $target terlalu besar untuk max_connections=$max_connections." >&2
  exit 1
fi

psql_local --command="alter role \"$role\" connection limit $target;" >/dev/null
echo "Budget koneksi PostgreSQL: $role dinaikkan dari $role_limit menjadi $target."
