#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_host="${1:-}"
health_site="${2:-}"
source_env="${ORACLE_NUTRITION_SOURCE_ENV:-$HOME/.config/e-posyandu/nutrition-grpc.env}"

if [[ -z "$ssh_host" || -z "$health_site" ]]; then
  echo "Penggunaan: npm run grpc:deploy:oracle -- ALIAS_SSH DOMAIN_HEALTH" >&2
  echo "Contoh: npm run grpc:deploy:oracle -- eposyandu-oracle nutrition.example.go.id" >&2
  exit 1
fi

if [[ ! "$ssh_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Alias SSH Oracle tidak valid." >&2
  exit 1
fi

if [[ ! "$health_site" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]] \
  && [[ ! "$health_site" =~ ^http://([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Gunakan domain valid atau http://IP_PUBLIK untuk health check sementara." >&2
  exit 1
fi

if [[ ! -f "$source_env" ]]; then
  echo "File secret belum tersedia: $source_env" >&2
  echo "Salin deploy/oracle/nutrition-grpc.env.example lalu isi nilainya di lokasi privat tersebut." >&2
  exit 1
fi

required_names=(
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_QUEUE_ID
  CLOUDFLARE_QUEUES_API_TOKEN
  EPOSYANDU_API_URL
  RUST_WORKER_SHARED_SECRET
)
for required_name in "${required_names[@]}"; do
  required_value="$(sed -n "s/^${required_name}=//p" "$source_env" | tail -n 1)"
  if [[ -z "$required_value" || "$required_value" == replace-* ]]; then
    echo "Isi $required_name pada $source_env sebelum deployment." >&2
    exit 1
  fi
done
unset required_value

task_temp="$(mktemp -d)"
remote_stage=""
cleanup() {
  rm -rf -- "$task_temp"
  if [[ -n "$remote_stage" && "$remote_stage" == /tmp/eposyandu-oracle.* ]]; then
    ssh "$ssh_host" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

secret_copy="$task_temp/nutrition-grpc.env"
awk -F= '$1 != "ORACLE_HEALTH_SITE"' "$source_env" > "$secret_copy"
printf '\nORACLE_HEALTH_SITE=%s\n' "$health_site" >> "$secret_copy"
chmod 600 "$secret_copy"

archive_file="$task_temp/e-posyandu-oracle.tar.gz"
COPYFILE_DISABLE=1 tar \
  --exclude='services/nutrition-grpc/target' \
  --exclude='services/nutrition-grpc/.env' \
  -czf "$archive_file" \
  -C "$project_root" \
  services/nutrition-grpc deploy/oracle

echo "Memeriksa koneksi SSH ke $ssh_host ..."
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" true
remote_stage="$(ssh "$ssh_host" 'mktemp -d /tmp/eposyandu-oracle.XXXXXX')"
if [[ "$remote_stage" != /tmp/eposyandu-oracle.* ]]; then
  echo "Direktori sementara Oracle tidak valid." >&2
  exit 1
fi

scp -q \
  "$archive_file" \
  "$secret_copy" \
  "$project_root/deploy/oracle/bootstrap.sh" \
  "$ssh_host:$remote_stage/"

release_id="$(date -u +%Y%m%d%H%M%S)"
echo "Membangun dan mengaktifkan nutrition worker di Oracle ..."
ssh "$ssh_host" \
  "sudo bash '$remote_stage/bootstrap.sh' '$remote_stage/e-posyandu-oracle.tar.gz' '$remote_stage/nutrition-grpc.env' '$release_id'"

if [[ "$health_site" == http://* ]]; then
  health_url="${health_site%/}/health"
else
  health_url="https://${health_site%/}/health"
fi

echo "Deployment Oracle selesai."
echo "Health check: $health_url"
echo "Hubungkan ke monitoring Cloudflare dengan:"
echo "npm run grpc:connect:oracle -- $health_url"
