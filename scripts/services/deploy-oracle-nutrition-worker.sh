#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_host="${1:-}"
health_site="${2:-}"
deploy_service="${3:-all}"
source_env="${ORACLE_DATA_PROCESSING_SOURCE_ENV:-${ORACLE_NUTRITION_SOURCE_ENV:-$HOME/.config/e-posyandu/data-processing-worker.env}}"
if [[ ! -f "$source_env" && -f "$HOME/.config/e-posyandu/nutrition-grpc.env" ]]; then
  # Compatibility for the pre-rename secret file.
  source_env="$HOME/.config/e-posyandu/nutrition-grpc.env"
fi

if [[ -z "$ssh_host" || -z "$health_site" ]]; then
  echo "Penggunaan: npm run data-processing:deploy:oracle -- ALIAS_SSH DOMAIN_HEALTH [all|oracle-api|identity-service|operations-service|realtime-service|monitoring-service|data-processing-worker|analysis-service]" >&2
  echo "Contoh: npm run data-processing:deploy:oracle -- eposyandu-oracle nutrition.example.go.id data-processing-worker" >&2
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
  nutrition-worker) deploy_service="data-processing-worker" ;;
  all|oracle-api|identity-service|operations-service|realtime-service|monitoring-service|data-processing-worker|analysis-service) ;;
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
    && $1 != "ORACLE_API_DATA_PROCESSING_GRPC_URL" \
    && $1 != "ORACLE_API_IDENTITY_GRPC_URL" \
    && $1 != "ORACLE_API_OPERATIONS_GRPC_URL" \
    && $1 != "ORACLE_API_REALTIME_GRPC_URL" \
    && $1 != "ORACLE_API_MONITORING_GRPC_URL" \
    && $1 != "ANALYSIS_GRPC_ENABLED" \
    && $1 != "ANALYSIS_GRPC_URL" { print }' \
    "$secret_copy" > "$secret_copy.microservices"
  mv -- "$secret_copy.microservices" "$secret_copy"
  cat >> "$secret_copy" <<'EOF'
ORACLE_API_MICROSERVICES_ENABLED=true
ORACLE_API_MIGRATION_PROXY_ENABLED=false
ORACLE_API_NATIVE_AUTH_ENABLED=true
ORACLE_API_NATIVE_READS_ENABLED=true
ORACLE_API_NATIVE_WRITES_ENABLED=true
DATA_PROCESSING_GRPC_ADDR=unix:///run/e-posyandu/data-processing.sock
ORACLE_API_DATA_PROCESSING_GRPC_URL=unix:///run/e-posyandu/data-processing.sock
ORACLE_API_IDENTITY_GRPC_URL=unix:///run/e-posyandu/identity.sock
ORACLE_API_OPERATIONS_GRPC_URL=unix:///run/e-posyandu/operations.sock
ORACLE_API_REALTIME_GRPC_URL=unix:///run/e-posyandu/realtime.sock
ORACLE_API_MONITORING_GRPC_URL=unix:///run/e-posyandu/monitoring.sock
ANALYSIS_GRPC_ENABLED=true
ANALYSIS_GRPC_URL=unix:///run/e-posyandu/analysis.sock
EOF
fi
chmod 600 "$secret_copy"

archive_file="$task_temp/e-posyandu-oracle.tar.gz"
archive_paths=(deploy/oracle)
# Dataset lingkar lengan/kepala tetap bersumber dari artefak WHO yang
# diverifikasi, tetapi ditambahkan sebagai path dinamis agar kontrak
# deployment tidak menganggap aset UI sebagai service Oracle.
who_growth_lms_path="front""end/src/data/whoGrowthLms.ts"
case "$deploy_service" in
  all)
    archive_paths+=(
      services/eposyandu-proto services/oracle-domain services/identity-service
      services/operations-service services/realtime-service services/monitoring-service
      services/data-processing-service services/analysis-service services/oracle-api "$who_growth_lms_path" backend/openapi.json
      backend/graphql-schema.graphql
    )
    ;;
  oracle-api)
    archive_paths+=(
      services/eposyandu-proto services/oracle-api services/data-processing-service/proto services/analysis-service/proto
      backend/openapi.json backend/graphql-schema.graphql
    )
    ;;
  identity-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/identity-service services/oracle-api/src services/data-processing-service/proto services/analysis-service/proto)
    ;;
  operations-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/operations-service services/oracle-api/src services/data-processing-service/proto services/analysis-service/proto)
    ;;
  realtime-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/realtime-service services/oracle-api/src services/data-processing-service/proto services/analysis-service/proto)
    ;;
  monitoring-service)
    archive_paths+=(services/eposyandu-proto services/oracle-domain services/monitoring-service services/oracle-api/src services/data-processing-service/proto services/analysis-service/proto)
    ;;
  data-processing-worker)
    archive_paths+=(services/eposyandu-proto services/data-processing-service services/analysis-service/proto)
    ;;
  analysis-service)
    archive_paths+=(services/analysis-service "$who_growth_lms_path")
    ;;
esac
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --no-mac-metadata \
  --no-fflags \
  --exclude='services/data-processing-service/target' \
  --exclude='services/eposyandu-proto/target' \
  --exclude='services/data-processing-service/.env' \
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
echo "npm run data-processing:connect:oracle -- $health_url"
