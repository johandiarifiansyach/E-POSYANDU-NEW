#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_URL="${1:-}"

if [[ -z "$SERVICE_URL" ]]; then
  printf 'Penggunaan: npm run grpc:connect:render -- https://nama-service.onrender.com\n' >&2
  exit 1
fi

if [[ "$SERVICE_URL" != https://* ]]; then
  printf 'URL Render harus memakai HTTPS.\n' >&2
  exit 1
fi

HEALTH_URL="${SERVICE_URL%/}"
if [[ "$HEALTH_URL" != */health ]]; then
  HEALTH_URL="$HEALTH_URL/health"
fi

printf 'Memeriksa nutrition worker di %s ...\n' "$HEALTH_URL"
curl --fail --silent --show-error \
  --retry 12 \
  --retry-all-errors \
  --retry-delay 5 \
  --max-time 15 \
  "$HEALTH_URL"
printf '\nNutrition worker aktif. Menyimpan URL health check ke Cloudflare...\n'

printf '%s' "$HEALTH_URL" \
  | npx --yes wrangler --cwd "$ROOT_DIR/backend" secret put RUST_WORKER_HEALTH_URL

cd "$ROOT_DIR"
npm run worker:deploy

printf '\nRender sudah tersambung. Cloudflare akan memeriksa worker setiap 10 menit.\n'
