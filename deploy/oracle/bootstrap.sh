#!/usr/bin/env bash
set -euo pipefail

archive_file="${1:-}"
secret_file="${2:-}"
release_id="${3:-}"

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
    ORACLE_API_MIGRATION_PROXY_ENABLED; do
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
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$previous_compose" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      up --detach --remove-orphans >&2 || \
      echo "Rollback otomatis gagal; pemeriksaan operator diperlukan." >&2
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

"${compose_command[@]}" \
  --project-name e-posyandu-oracle \
  --file "$compose_file" \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  up --detach --build --remove-orphans

health_site="$(sed -n 's/^ORACLE_HEALTH_SITE=//p' /etc/e-posyandu/nutrition-grpc.env | tail -n 1)"
if [[ "$health_site" == http://* ]]; then
  health_host="${health_site#http://}"
  health_check=(curl --fail --silent --show-error --max-time 3 -H "Host: $health_host" http://127.0.0.1/health)
else
  health_host="$health_site"
  health_check=(curl --fail --silent --show-error --max-time 5 --resolve "$health_host:443:127.0.0.1" "https://$health_host/health")
fi
api_health_check=(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8081/health)
frontend_health_check=(curl --fail --silent --show-error --max-time 3 http://127.0.0.1:8082/)

for attempt in $(seq 1 30); do
  if "${health_check[@]}" 2>/dev/null | grep -Fq "E-Posyandu nutrition worker aktif" \
    && "${api_health_check[@]}" 2>/dev/null | grep -Fq '"service":"e-posyandu-oracle-api"' \
    && "${frontend_health_check[@]}" 2>/dev/null | grep -Fqi '<html'; then
    ln -sfn "$release_dir" /opt/e-posyandu/current
    release_activated=true
    echo "API dan nutrition worker Oracle aktif."
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$compose_file" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      ps
    exit 0
  fi
  sleep 2
done

echo "Frontend, API, atau nutrition worker belum sehat setelah 60 detik." >&2
"${compose_command[@]}" \
  --project-name e-posyandu-oracle \
  --file "$compose_file" \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  logs --tail 80 >&2
exit 1
