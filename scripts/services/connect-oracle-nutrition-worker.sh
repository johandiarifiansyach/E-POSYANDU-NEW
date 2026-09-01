#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service_url="${1:-}"

if [[ -z "$service_url" ]]; then
  echo "Penggunaan: npm run data-processing:connect:oracle -- https://data-processing.example.go.id/health" >&2
  exit 1
fi

if [[ "$service_url" != https://* ]] \
  && [[ ! "$service_url" =~ ^http://([0-9]{1,3}\.){3}[0-9]{1,3}(/health)?$ ]]; then
  echo "URL Oracle harus memakai HTTPS. HTTP hanya diizinkan sementara untuk alamat IP." >&2
  exit 1
fi

health_url="${service_url%/}"
if [[ "$health_url" != */health ]]; then
  health_url="$health_url/health"
fi

echo "Memeriksa data processing worker Oracle di $health_url ..."
health_body="$(curl --fail --silent --show-error \
  --retry 12 \
  --retry-all-errors \
  --retry-delay 5 \
  --max-time 15 \
  "$health_url")"
if [[ "$health_body" != "E-Posyandu data processing worker aktif" ]]; then
  echo "Respons health check Oracle tidak sesuai." >&2
  exit 1
fi
unset health_body

echo "Menyimpan URL health check ke secret Cloudflare ..."
printf '%s' "$health_url" \
  | npx --yes wrangler --cwd "$project_root/backend" secret put RUST_WORKER_HEALTH_URL

cd "$project_root"
npm run worker:deploy

echo "Oracle sudah tersambung. Cloudflare akan memeriksa data processing worker setiap 10 menit."
