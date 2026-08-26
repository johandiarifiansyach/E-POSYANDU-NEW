#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_host="${1:-}"
health_site="${2:-}"
deploy_service="${3:-all}"
source_env="${ORACLE_NUTRITION_SOURCE_ENV:-$HOME/.config/e-posyandu/nutrition-grpc.env}"

if [[ -z "$ssh_host" || -z "$health_site" ]]; then
  echo "Penggunaan: npm run grpc:deploy:oracle -- ALIAS_SSH DOMAIN_HEALTH [all|oracle-api|identity-service|operations-service|realtime-service|monitoring-service|nutrition-worker]" >&2
  echo "Contoh: npm run grpc:deploy:oracle -- eposyandu-oracle nutrition.example.go.id nutrition-worker" >&2
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

case "$deploy_service" in
  all|oracle-api|identity-service|operations-service|realtime-service|monitoring-service|nutrition-worker) ;;
  *)
    echo "Service Oracle tidak valid: $deploy_service" >&2
    exit 1
    ;;
esac

skip_build="${ORACLE_DEPLOY_SKIP_BUILD:-false}"
case "$skip_build" in
  true|false) ;;
  *)
    echo "ORACLE_DEPLOY_SKIP_BUILD harus bernilai true atau false." >&2
    exit 1
    ;;
esac

if [[ ! -f "$source_env" ]]; then
  echo "File secret belum tersedia: $source_env" >&2
  echo "Salin deploy/oracle/nutrition-grpc.env.example lalu isi nilainya di lokasi privat tersebut." >&2
  exit 1
fi

required_names=(
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_QUEUE_ID
  EPOSYANDU_API_URL
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
awk -F= '$1 != "ORACLE_HEALTH_SITE" && $1 != "CLOUDFLARE_QUEUES_API_TOKEN" && $1 != "RUST_WORKER_SHARED_SECRET"' \
  "$source_env" > "$secret_copy"
printf '\nORACLE_HEALTH_SITE=%s\n' "$health_site" >> "$secret_copy"

# Rilis penuh wajib menggunakan gateway microservices-only. Hapus nilai lama
# dari env server agar konfigurasi transisi monolith tidak dapat mengaktifkan
# fallback secara tidak sengaja, lalu tulis nilai produksi yang eksplisit.
if [[ "$deploy_service" == "all" ]]; then
  awk -F= '$1 != "ORACLE_API_MICROSERVICES_ENABLED" \
    && $1 != "ORACLE_API_MIGRATION_PROXY_ENABLED" \
    && $1 != "ORACLE_API_NATIVE_AUTH_ENABLED" \
    && $1 != "ORACLE_API_NATIVE_READS_ENABLED" \
    && $1 != "ORACLE_API_NATIVE_WRITES_ENABLED" \
    && $1 != "GRPC_ADDR" \
    && $1 != "ORACLE_API_NUTRITION_GRPC_URL" \
    && $1 != "ORACLE_API_IDENTITY_GRPC_URL" \
    && $1 != "ORACLE_API_OPERATIONS_GRPC_URL" \
    && $1 != "ORACLE_API_REALTIME_GRPC_URL" \
    && $1 != "ORACLE_API_MONITORING_GRPC_URL" { print }' \
    "$secret_copy" > "$secret_copy.microservices"
  mv -- "$secret_copy.microservices" "$secret_copy"
  cat >> "$secret_copy" <<'EOF'
ORACLE_API_MICROSERVICES_ENABLED=true
ORACLE_API_MIGRATION_PROXY_ENABLED=false
ORACLE_API_NATIVE_AUTH_ENABLED=false
ORACLE_API_NATIVE_READS_ENABLED=false
ORACLE_API_NATIVE_WRITES_ENABLED=false
GRPC_ADDR=unix:///run/e-posyandu/nutrition.sock
ORACLE_API_NUTRITION_GRPC_URL=unix:///run/e-posyandu/nutrition.sock
ORACLE_API_IDENTITY_GRPC_URL=unix:///run/e-posyandu/identity.sock
ORACLE_API_OPERATIONS_GRPC_URL=unix:///run/e-posyandu/operations.sock
ORACLE_API_REALTIME_GRPC_URL=unix:///run/e-posyandu/realtime.sock
ORACLE_API_MONITORING_GRPC_URL=unix:///run/e-posyandu/monitoring.sock
EOF
fi
chmod 600 "$secret_copy"

archive_file="$task_temp/e-posyandu-oracle.tar.gz"
archive_paths=(deploy/oracle)
case "$deploy_service" in
  all)
    archive_paths+=(
      services/eposyandu-proto services/oracle-domain services/identity-service
      services/operations-service services/realtime-service services/monitoring-service
      services/nutrition-grpc services/oracle-api backend/openapi.json
      backend/graphql-schema.graphql
    )
    ;;
  oracle-api)
    archive_paths+=(
      services/eposyandu-proto services/oracle-api services/nutrition-grpc/proto
      backend/openapi.json backend/graphql-schema.graphql
    )
    ;;
  identity-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/identity-service services/oracle-api/src services/nutrition-grpc/proto)
    ;;
  operations-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/operations-service services/oracle-api/src services/nutrition-grpc/proto)
    ;;
  realtime-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/realtime-service services/oracle-api/src services/nutrition-grpc/proto)
    ;;
  monitoring-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/monitoring-service services/oracle-api/src services/nutrition-grpc/proto)
    ;;
  nutrition-worker)
    archive_paths+=(services/eposyandu-proto services/nutrition-grpc)
    ;;
esac
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --no-mac-metadata \
  --no-fflags \
  --exclude='services/nutrition-grpc/target' \
  --exclude='services/eposyandu-proto/target' \
  --exclude='services/nutrition-grpc/.env' \
  --exclude='services/oracle-api/target' \
  --exclude='services/oracle-domain/target' \
  --exclude='services/*-service/target' \
  -czf "$archive_file" \
  -C "$project_root" \
  "${archive_paths[@]}"

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
echo "Membangun dan mengaktifkan service Oracle: $deploy_service ..."
bootstrap_command="sudo bash"
if [[ "$skip_build" == "true" ]]; then
  bootstrap_command="sudo env ORACLE_DEPLOY_SKIP_BUILD=true bash"
fi
ssh "$ssh_host" \
  "$bootstrap_command '$remote_stage/bootstrap.sh' '$remote_stage/e-posyandu-oracle.tar.gz' '$remote_stage/nutrition-grpc.env' '$release_id' '$deploy_service'"

if [[ "$health_site" == http://* ]]; then
  health_url="${health_site%/}/health"
else
  health_url="https://${health_site%/}/health"
fi

echo "Deployment service Oracle selesai: $deploy_service."
echo "Health check: $health_url"
echo "API migration gateway internal: http://127.0.0.1:8081/health"
echo "Hubungkan ke monitoring Cloudflare dengan:"
echo "npm run grpc:connect:oracle -- $health_url"
