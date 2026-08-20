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
  dnf install --assumeyes container-tools oracle-epel-release-el9
  dnf config-manager --enable ol9_developer_EPEL
  dnf install --assumeyes podman-compose
  systemctl enable podman-restart.service
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install --yes --no-install-recommends ca-certificates docker.io

  if ! docker compose version >/dev/null 2>&1; then
    if ! apt-get install --yes --no-install-recommends docker-compose-v2; then
      apt-get install --yes --no-install-recommends docker-compose-plugin
    fi
  fi
  systemctl enable --now docker
fi

release_dir="/opt/e-posyandu/releases/$release_id"
install -d -m 0750 /opt/e-posyandu/releases /etc/e-posyandu "$release_dir"
tar -xzf "$archive_file" --no-same-owner -C "$release_dir"
install -m 0600 "$secret_file" /etc/e-posyandu/nutrition-grpc.env

compose_file="$release_dir/deploy/oracle/compose.yaml"
if [[ ! -f "$compose_file" ]]; then
  echo "Konfigurasi Compose Oracle tidak ditemukan dalam archive." >&2
  exit 1
fi

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

ln -sfn "$release_dir" /opt/e-posyandu/current

for attempt in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 3 \
    http://127.0.0.1/health 2>/dev/null \
    | grep -Fq "E-Posyandu nutrition worker aktif"; then
    echo "Nutrition worker Oracle aktif."
    "${compose_command[@]}" \
      --project-name e-posyandu-oracle \
      --file "$compose_file" \
      --env-file /etc/e-posyandu/nutrition-grpc.env \
      ps
    exit 0
  fi
  sleep 2
done

echo "Nutrition worker belum sehat setelah 60 detik." >&2
"${compose_command[@]}" \
  --project-name e-posyandu-oracle \
  --file "$compose_file" \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  logs --tail 80 --no-color >&2
exit 1
