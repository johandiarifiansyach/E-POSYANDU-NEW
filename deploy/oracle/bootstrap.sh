#!/usr/bin/env bash
set -euo pipefail

archive_file="${1:-}"
secret_file="${2:-}"
release_id="${3:-}"
deployment_service="${4:-all}"
skip_build="${ORACLE_DEPLOY_SKIP_BUILD:-false}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Bootstrap Oracle harus dijalankan melalui sudo/root." >&2
  exit 1
fi

if [[ ! -f "$archive_file" || ! -f "$secret_file" ]]; then
  echo "Archive aplikasi atau file secret tidak ditemukan." >&2
  exit 1
fi

if [[ ! "$release_id" =~ ^[0-9]{14}$ ]]; then
  echo "ID rilis Oracle tidak valid." >&2
  exit 1
fi

case "$deployment_service" in
  nutrition-worker) deployment_service="data-processing-worker" ;;
  all|oracle-api|identity-service|operations-service|realtime-service|monitoring-service|data-processing-worker|analysis-service) ;;
  *)
    echo "Service Oracle tidak valid: $deployment_service" >&2
    exit 1
    ;;
esac

case "$skip_build" in
  true|false) ;;
  *)
    echo "ORACLE_DEPLOY_SKIP_BUILD harus bernilai true atau false." >&2
    exit 1
    ;;
esac

if [[ ! -f /etc/os-release ]]; then
  echo "Sistem operasi Oracle tidak dapat dikenali." >&2
  exit 1
fi

# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}" in
  ol)
    if [[ "${VERSION_ID%%.*}" != "9" ]]; then
      echo "Bootstrap Oracle hanya mendukung Oracle Linux 9." >&2
      exit 1
    fi
    container_engine="podman"
    compose_command=(podman-compose)
    export BUILDAH_FORMAT=docker
    ;;
  ubuntu|debian)
    container_engine="docker"
    compose_command=(docker compose)
    ;;
  *)
    echo "Bootstrap mendukung Oracle Linux 9 serta Ubuntu/Debian." >&2
    exit 1
    ;;
esac

while IFS= read -r archive_entry; do
  case "$archive_entry" in
    /*|../*|*/../*)
      echo "Archive deployment memiliki path yang tidak aman." >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "$archive_file")

if [[ "$container_engine" == "podman" ]]; then
  dnf install --assumeyes container-tools oracle-epel-release-el9 gnupg2
  dnf config-manager --enable ol9_developer_EPEL
  dnf install --assumeyes podman-compose
  systemctl enable podman-restart.service
  if systemctl is-active --quiet firewalld; then
    firewall-cmd --query-service=http >/dev/null || firewall-cmd --add-service=http
    firewall-cmd --query-service=https >/dev/null || firewall-cmd --add-service=https
    firewall-cmd --permanent --query-service=http >/dev/null \
      || firewall-cmd --permanent --add-service=http
    firewall-cmd --permanent --query-service=https >/dev/null \
      || firewall-cmd --permanent --add-service=https
  fi
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install --yes --no-install-recommends ca-certificates docker.io gnupg

  if ! docker compose version >/dev/null 2>&1; then
    if ! apt-get install --yes --no-install-recommends docker-compose-v2; then
      apt-get install --yes --no-install-recommends docker-compose-plugin
    fi
  fi
  systemctl enable --now docker
fi

release_dir="/opt/e-posyandu/releases/$release_id"
install -d -m 0750 /opt/e-posyandu/releases /etc/e-posyandu /var/lib/e-posyandu "$release_dir"
install -d -o 10001 -g 10001 -m 0700 /var/lib/e-posyandu/oracle-api
install -d -o 10001 -g 10001 -m 0700 /var/lib/e-posyandu/grpc
tar -xzf "$archive_file" --no-same-owner -C "$release_dir"

# Nilai berikut merupakan state migrasi/cutover di server. Pertahankan bila
# file sumber deployment belum memuatnya, agar update aplikasi tidak membuka
# origin, mematikan Tunnel, atau menurunkan mode API secara tidak sengaja.
declare -A preserved_deployment_values=()
if [[ -f /etc/e-posyandu/nutrition-grpc.env ]]; then
  for deployment_name in \
    COMPOSE_PROFILES \
    ORACLE_PUBLIC_BIND \
    ORACLE_API_NATIVE_AUTH_ENABLED \
    ORACLE_API_NATIVE_READS_ENABLED \
    ORACLE_API_NATIVE_WRITES_ENABLED \
    ORACLE_API_MIGRATION_PROXY_ENABLED \
    ORACLE_API_DATA_PROCESSING_GRPC_URL \
    ANALYSIS_GRPC_ENABLED \
    ANALYSIS_GRPC_URL; do
    deployment_value="$(sed -n "s/^${deployment_name}=//p" /etc/e-posyandu/nutrition-grpc.env | tail -n 1)"
    if [[ -n "$deployment_value" ]]; then
      preserved_deployment_values["$deployment_name"]="$deployment_value"
    fi
  done
fi
install -m 0600 "$secret_file" /etc/e-posyandu/nutrition-grpc.env
for deployment_name in "${!preserved_deployment_values[@]}"; do
  if ! grep -q "^${deployment_name}=" /etc/e-posyandu/nutrition-grpc.env; then
    printf '%s=%s\n' "$deployment_name" "${preserved_deployment_values[$deployment_name]}" \
      >> /etc/e-posyandu/nutrition-grpc.env
  fi
done
install -o root -g root -m 0750 \
  "$release_dir/deploy/oracle/oracle-native-mode.sh" \
  /usr/local/sbin/eposyandu-native-mode

monitoring_dir="$release_dir/deploy/oracle/monitoring"
if [[ -f "$monitoring_dir/eposyandu-oci-metrics.py" ]]; then
  install -d -m 0750 /usr/local/libexec/e-posyandu
  install -o root -g root -m 0750 \
    "$monitoring_dir/eposyandu-oci-metrics.py" \
    /usr/local/libexec/e-posyandu/eposyandu-oci-metrics.py
  install -o root -g root -m 0644 \
    "$monitoring_dir/eposyandu-oci-metrics.service" \
    /etc/systemd/system/eposyandu-oci-metrics.service
  install -o root -g root -m 0644 \
    "$monitoring_dir/eposyandu-oci-metrics.timer" \
    /etc/systemd/system/eposyandu-oci-metrics.timer
  systemctl daemon-reload
  systemctl enable --now eposyandu-oci-metrics.timer
fi

vault_dir="$release_dir/deploy/oracle/vault"
if [[ -f "$vault_dir/eposyandu-vault-env.py" && -f "$vault_dir/eposyandu-vault-env.service" ]]; then
  if [[ ! -f /etc/e-posyandu/vault.env ]]; then
    echo "Konfigurasi OCI Vault tidak ditemukan: /etc/e-posyandu/vault.env" >&2
    echo "Buat file tersebut dari deploy/oracle/vault/eposyandu-vault.env.example." >&2
    exit 1
  fi
  install -d -o root -g root -m 0750 /usr/local/libexec/e-posyandu
  install -o root -g root -m 0750 \
    "$vault_dir/eposyandu-vault-env.py" \
    /usr/local/libexec/e-posyandu/eposyandu-vault-env.py
  install -o root -g root -m 0644 \
    "$vault_dir/eposyandu-vault-env.service" \
    /etc/systemd/system/eposyandu-vault-env.service
  systemctl daemon-reload
  systemctl enable eposyandu-vault-env.service
  systemctl restart eposyandu-vault-env.service
  if [[ ! -s /run/e-posyandu/nutrition-grpc-vault.env ]]; then
    echo "Secret runtime OCI tidak berhasil disiapkan." >&2
    exit 1
  fi
  if [[ ! -e /run/e-posyandu/oracle-api-vault.env ]]; then
    echo "File secret runtime API Oracle tidak berhasil disiapkan." >&2
    exit 1
  fi
fi

backup_dir="$release_dir/deploy/oracle/backup"
if [[ -f "$backup_dir/eposyandu-backup.py" && -f "$backup_dir/eposyandu-backup.service" && -f "$backup_dir/eposyandu-backup.timer" ]]; then
  install -d -o root -g root -m 0750 /usr/local/libexec/e-posyandu /var/lib/e-posyandu/backup
  install -o root -g root -m 0750 \
    "$backup_dir/eposyandu-backup.py" \
    /usr/local/libexec/e-posyandu/eposyandu-backup.py
  install -o root -g root -m 0644 \
    "$backup_dir/eposyandu-backup.service" \
    /etc/systemd/system/eposyandu-backup.service
  install -o root -g root -m 0644 \
    "$backup_dir/eposyandu-backup.timer" \
    /etc/systemd/system/eposyandu-backup.timer
  systemctl daemon-reload
  if [[ -f /etc/e-posyandu/backup.env ]]; then
    chmod 600 /etc/e-posyandu/backup.env
    systemctl enable --now eposyandu-backup.timer
  else
    systemctl disable --now eposyandu-backup.timer >/dev/null 2>&1 || true
    echo "Backup OCI belum aktif: /etc/e-posyandu/backup.env belum dibuat." >&2
  fi
fi

postgresql_dir="$release_dir/deploy/oracle/postgresql"
if [[ -f "$postgresql_dir/eposyandu-postgresql-migrate.py" \
  && -x /usr/bin/pg_dump \
  && -x /usr/bin/pg_restore ]]; then
  install -d -o root -g root -m 0750 /usr/local/libexec/e-posyandu
  install -d -o postgres -g postgres -m 0700 /var/lib/pgsql/migration
  install -o root -g root -m 0750 \
    "$postgresql_dir/eposyandu-postgresql-migrate.py" \
    /usr/local/libexec/e-posyandu/eposyandu-postgresql-migrate.py
fi
if [[ -f "$postgresql_dir/eposyandu-postgresql-backup.py" \
  && -f "$postgresql_dir/eposyandu-postgresql-backup.service" \
  && -f "$postgresql_dir/eposyandu-postgresql-backup.timer" \
  && -f /etc/e-posyandu/backup.env \
  && -x /usr/bin/pg_dump ]]; then
  install -d -o root -g root -m 0750 /usr/local/libexec/e-posyandu
  install -d -o postgres -g postgres -m 0700 /var/lib/pgsql/backup
  install -o root -g root -m 0750 \
    "$postgresql_dir/eposyandu-postgresql-backup.py" \
    /usr/local/libexec/e-posyandu/eposyandu-postgresql-backup.py
  install -o root -g root -m 0644 \
    "$postgresql_dir/eposyandu-postgresql-backup.service" \
    /etc/systemd/system/eposyandu-postgresql-backup.service
  install -o root -g root -m 0644 \
    "$postgresql_dir/eposyandu-postgresql-backup.timer" \
    /etc/systemd/system/eposyandu-postgresql-backup.timer
  systemctl daemon-reload
  systemctl enable --now eposyandu-postgresql-backup.timer
fi

compose_file="$release_dir/deploy/oracle/compose.yaml"
if [[ ! -f "$compose_file" ]]; then
  echo "Konfigurasi Compose Oracle tidak ditemukan dalam archive." >&2
  exit 1
fi

compose_profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' /etc/e-posyandu/nutrition-grpc.env | tail -n 1)"
public_bind="$(sed -n 's/^ORACLE_PUBLIC_BIND=//p' /etc/e-posyandu/nutrition-grpc.env | tail -n 1)"
case "${public_bind:-0.0.0.0}" in
  0.0.0.0|127.0.0.1) ;;
  *)
    echo "ORACLE_PUBLIC_BIND hanya boleh 0.0.0.0 atau 127.0.0.1." >&2
    exit 1
    ;;
esac
export COMPOSE_PROFILES="$compose_profiles"
case ",${compose_profiles// /,}," in
  *,cloudflare-tunnel,*)
    if [[ ! -s /run/e-posyandu/cloudflare-tunnel-token ]]; then
      echo "Profile Tunnel aktif tetapi token OCI Vault belum tersedia." >&2
      exit 1
    fi
    ;;
esac

previous_release="$(readlink -f /opt/e-posyandu/current 2>/dev/null || true)"
previous_compose=""
if [[ "$previous_release" == /opt/e-posyandu/releases/* \
  && -f "$previous_release/deploy/oracle/compose.yaml" ]]; then
  previous_compose="$previous_release/deploy/oracle/compose.yaml"
fi
deployment_started=false
release_activated=false
rollback_on_failure() {
  local exit_code=$?
  if [[ "$exit_code" -ne 0 && "$deployment_started" == true \
    && "$release_activated" != true && -n "$previous_compose" ]]; then
    echo "Rilis baru gagal; memulihkan konfigurasi Oracle sebelumnya." >&2
    if [[ "$deployment_service" == "all" ]]; then
      "${compose_command[@]}" \
        --project-name e-posyandu-oracle \
        --file "$previous_compose" \
        --env-file /etc/e-posyandu/nutrition-grpc.env \
        up --detach --remove-orphans >&2
    else
      "${compose_command[@]}" \
        --project-name e-posyandu-oracle \
        --file "$previous_compose" \
        --env-file /etc/e-posyandu/nutrition-grpc.env \
        up --detach --no-deps "$deployment_service" >&2
    fi || echo "Rollback otomatis gagal; pemeriksaan operator diperlukan." >&2
  fi
  exit "$exit_code"
}
trap rollback_on_failure EXIT

deployment_started=true
"${compose_command[@]}" \
  --project-name e-posyandu-oracle \
  --file "$compose_file" \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  config >/dev/null

if [[ "$deployment_service" == "all" && "$skip_build" != "true" ]]; then
  # Build satu per satu. VM Oracle Always Free hanya memiliki disk/CPU
  # terbatas; membangun enam image Rust bersamaan membuat setiap target
  # menyimpan artefak Cargo duplikat dan dapat menghabiskan disk sebelum
  # container baru dibuat. Container lama tetap berjalan selama tahap build.
  for build_service in \
    identity-service \
    operations-service \
    realtime-service \
    monitoring-service \
    data-processing-worker \
    analysis-service \
    oracle-api; do
    echo "Membangun image $build_service secara berurutan ..."
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$compose_file" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      build "$build_service"
    if [[ "$container_engine" == "podman" ]]; then
      # Hanya hapus layer/image dangling; image yang sedang dipakai container
      # lama maupun image service yang baru selesai tetap dipertahankan.
      podman image prune --force >/dev/null || true
    fi
  done
  "${compose_command[@]}" \
    --project-name e-posyandu-oracle \
    --file "$compose_file" \
    --env-file /etc/e-posyandu/nutrition-grpc.env \
    up --detach --no-build --remove-orphans
elif [[ "$deployment_service" == "all" ]]; then
  # Mode ini hanya dipakai ketika image bertag sudah dibangun pada release
  # sebelumnya. Tidak ada compile/pull image pada tahap aktivasi.
  echo "Mengaktifkan image Oracle yang sudah tersedia tanpa build ..."
  "${compose_command[@]}" \
    --project-name e-posyandu-oracle \
    --file "$compose_file" \
    --env-file /etc/e-posyandu/nutrition-grpc.env \
    up --detach --no-build --remove-orphans
else
  # podman-compose refuses to replace a running container while health-proxy
  # keeps a dependency reference to it.  Remove that dependency tree first;
  # the proxy is recreated immediately after the target worker below.
  if [[ "$container_engine" == "podman" && "$deployment_service" == "data-processing-worker" ]]; then
    worker_container="e-posyandu-oracle_data-processing-worker_1"
    if podman container exists "$worker_container"; then
      podman rm --force --depend "$worker_container" >&2
    fi
  fi
  "${compose_command[@]}" \
    --project-name e-posyandu-oracle \
    --file "$compose_file" \
    --env-file /etc/e-posyandu/nutrition-grpc.env \
    up --detach --no-deps --build "$deployment_service"
  if [[ "$container_engine" == "podman" && "$deployment_service" == "data-processing-worker" ]]; then
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$compose_file" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      up --detach --no-build health-proxy
  fi
fi

health_site="$(sed -n 's/^ORACLE_HEALTH_SITE=//p' /etc/e-posyandu/nutrition-grpc.env | tail -n 1)"
if [[ "$health_site" == http://* ]]; then
  health_host="${health_site#http://}"
  health_check=(curl --fail --silent --show-error --max-time 3 -H "Host: $health_host" http://127.0.0.1/health)
else
  health_host="$health_site"
  health_check=(curl --fail --silent --show-error --max-time 5 --resolve "$health_host:443:127.0.0.1" "https://$health_host/health")
fi
api_health_check=(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8081/api/v1/health/ready)

for attempt in $(seq 1 30); do
  service_healthy=true
  if [[ "$deployment_service" == "all" || "$deployment_service" == "data-processing-worker" ]]; then
    "${health_check[@]}" 2>/dev/null | grep -Fq "E-Posyandu data processing worker aktif" || service_healthy=false
  fi
  if [[ "$deployment_service" == "all" || "$deployment_service" == "oracle-api" ]]; then
    "${api_health_check[@]}" 2>/dev/null | grep -Fq '"ok":true' || service_healthy=false
  fi
  for internal_service in identity-service operations-service realtime-service monitoring-service; do
    if [[ "$deployment_service" == "all" || "$deployment_service" == "$internal_service" ]]; then
      # podman-compose versi yang tersedia di Oracle Linux tidak menerima
      # nama service sebagai argumen `ps`. Periksa container yang dibuat
      # Compose secara langsung agar health gate tidak selalu false.
      internal_container="e-posyandu-oracle_${internal_service}_1"
      internal_status="$($container_engine inspect \
        --format '{{.State.Status}}' "$internal_container" 2>/dev/null || true)"
      [[ "$internal_status" == "running" ]] || service_healthy=false
    fi
  done
  if [[ "$deployment_service" == "all" || "$deployment_service" == "analysis-service" ]]; then
    analysis_container="e-posyandu-oracle_analysis-service_1"
    analysis_status="$($container_engine inspect \
      --format '{{.State.Status}}' "$analysis_container" 2>/dev/null || true)"
    [[ "$analysis_status" == "running" ]] || service_healthy=false
  fi
  if [[ "$service_healthy" == true ]]; then
    ln -sfn "$release_dir" /opt/e-posyandu/current
    release_activated=true
    if [[ "$deployment_service" == "all" ]]; then
      echo "API dan data processing worker Oracle aktif."
    else
      echo "Service Oracle $deployment_service aktif; service lain tidak di-restart."
    fi
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$compose_file" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      ps
    exit 0
  fi
  sleep 2
done

echo "Service Oracle $deployment_service belum sehat setelah 60 detik." >&2
"${compose_command[@]}" \
  --project-name e-posyandu-oracle \
  --file "$compose_file" \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  logs --tail 80 >&2
exit 1
