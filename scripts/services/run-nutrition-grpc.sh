#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${EPOSYANDU_GRPC_ENV_FILE:-$HOME/.config/e-posyandu/nutrition-grpc.env}"
binary="${EPOSYANDU_GRPC_BINARY:-$project_root/services/nutrition-grpc/target/release/e-posyandu-nutrition-grpc}"

if [[ ! -f "$env_file" ]]; then
  echo "Konfigurasi gRPC tidak ditemukan: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_QUEUE_ID
  CLOUDFLARE_QUEUES_API_TOKEN
  EPOSYANDU_API_URL
  RUST_WORKER_SHARED_SECRET
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" || "${!name}" == replace-* ]]; then
    echo "Environment $name belum diisi." >&2
    exit 1
  fi
done

if [[ ! -x "$binary" ]]; then
  echo "Binary gRPC belum dibuat. Jalankan npm run grpc:build." >&2
  exit 1
fi

exec "$binary"
