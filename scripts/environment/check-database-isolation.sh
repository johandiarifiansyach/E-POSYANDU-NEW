#!/usr/bin/env bash
set -euo pipefail

required=(DEVELOPMENT_SUPABASE_URL STAGING_SUPABASE_URL PRODUCTION_SUPABASE_URL)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf 'Variabel %s belum diisi.\n' "$name" >&2
    exit 1
  fi
done

project_ref() {
  local value="${1#*://}"
  local host="${value%%/*}"
  host="${host%%:*}"
  printf '%s' "${host%%.*}"
}

development_ref="$(project_ref "$DEVELOPMENT_SUPABASE_URL")"
staging_ref="$(project_ref "$STAGING_SUPABASE_URL")"
production_ref="$(project_ref "$PRODUCTION_SUPABASE_URL")"

for entry in \
  "development:$development_ref" \
  "staging:$staging_ref" \
  "production:$production_ref"; do
  name="${entry%%:*}"
  value="${entry#*:}"
  if [[ -z "$value" || "$value" == "project-ref" ]]; then
    printf 'Project Supabase %s tidak valid.\n' "$name" >&2
    exit 1
  fi
done

if [[ "$development_ref" == "$staging_ref" \
  || "$development_ref" == "$production_ref" \
  || "$staging_ref" == "$production_ref" ]]; then
  printf 'Gagal: development, staging, dan production masih memakai project Supabase yang sama.\n' >&2
  exit 1
fi

printf 'Berhasil: tiga environment memakai project Supabase yang berbeda.\n'
printf 'development=%s, staging=%s, production=%s\n' \
  "$development_ref" "$staging_ref" "$production_ref"
