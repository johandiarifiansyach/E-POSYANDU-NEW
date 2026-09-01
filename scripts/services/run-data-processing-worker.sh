#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="${EPOSYANDU_DATA_PROCESSING_ENV_FILE:-$HOME/.config/e-posyandu/data-processing-worker.env}"
binary="${EPOSYANDU_DATA_PROCESSING_BINARY:-$project_root/services/data-processing-service/target/release/data-processing-worker}"

if [[ ! -f "$env_file" ]]; then
  echo "Konfigurasi data processing tidak ditemukan: $env_file" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ ! -x "$binary" ]]; then
  echo "Binary data-processing-worker belum dibuat. Jalankan npm run data-processing:build." >&2
  exit 1
fi

exec "$binary"
