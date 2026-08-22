#!/usr/bin/env bash
set -euo pipefail

action="${1:-}"
standby_dir="/opt/e-posyandu/standby"
compose_file="$standby_dir/compose.yaml"
runtime_secret_dir="/run/e-posyandu"
container_secret_dir="$runtime_secret_dir/standby-container-secrets"
lock_file="$runtime_secret_dir/oracle-standby.lock"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Pengelola standby harus dijalankan sebagai root." >&2
  exit 1
fi
if [[ ! -f "$compose_file" ]]; then
  echo "Konfigurasi standby tidak ditemukan: $compose_file" >&2
  exit 1
fi

if command -v podman-compose >/dev/null 2>&1; then
  compose=(podman-compose --project-name e-posyandu-oracle-standby --file "$compose_file")
  container_engine="podman"
elif docker compose version >/dev/null 2>&1; then
  compose=(docker compose --project-name e-posyandu-oracle-standby --file "$compose_file")
  container_engine="docker"
else
  echo "Podman Compose atau Docker Compose tidak tersedia." >&2
  exit 1
fi

if ! command -v flock >/dev/null 2>&1; then
  echo "Perintah flock diperlukan untuk mencegah sinkronisasi bersamaan." >&2
  exit 1
fi
if [[ "${EPOSYANDU_STANDBY_LOCKED:-0}" != "1" ]]; then
  # Keep the lock file descriptor inherited by the child process. Using
  # --close here releases the lock immediately before the real sync starts.
  exec flock --wait 120 "$lock_file" \
    env EPOSYANDU_STANDBY_LOCKED=1 "$0" "$@"
fi

prepare_container_secrets() {
  local source_file target_file
  local secret_mapping=(
    "oracle-standby-source-database-url:source-database-url"
    "oracle-standby-postgres-password:postgres-password"
    "oracle-standby-reader-password:reader-password"
  )

  install -d -o root -g 70 -m 0710 "$container_secret_dir"
  for mapping in "${secret_mapping[@]}"; do
    source_file="$runtime_secret_dir/${mapping%%:*}"
    target_file="$container_secret_dir/${mapping##*:}"
    if [[ ! -s "$source_file" ]]; then
      echo "Secret runtime standby belum tersedia: $source_file" >&2
      exit 1
    fi
    install -o 70 -g 70 -m 0400 "$source_file" "$target_file"
  done
}

clear_container_secrets() {
  rm -f -- \
    "$container_secret_dir/source-database-url" \
    "$container_secret_dir/postgres-password" \
    "$container_secret_dir/reader-password"
  rmdir -- "$container_secret_dir" 2>/dev/null || true
}

get_postgres_container() {
  if [[ "$container_engine" == "podman" ]]; then
    podman ps --all --quiet \
      --filter label=io.podman.compose.project=e-posyandu-oracle-standby \
      --filter label=io.podman.compose.service=postgres 2>/dev/null | head -n 1 || true
  else
    "${compose[@]}" ps --quiet postgres 2>/dev/null | head -n 1 || true
  fi
}

wait_for_postgres() {
  local container_id container_status health_status
  for _ in {1..60}; do
    container_id="$(get_postgres_container)"
    if [[ -n "$container_id" ]]; then
      container_status="$("$container_engine" inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
      health_status="$("$container_engine" inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
      if [[ "$health_status" == "healthy" ]]; then
        return 0
      fi
      if [[ "$container_status" == "exited" || "$container_status" == "dead" ]]; then
        break
      fi
    fi
    sleep 2
  done

  echo "Container PostgreSQL standby tidak mencapai status sehat." >&2
  "${compose[@]}" logs --tail 50 postgres >&2 || true
  return 1
}

ensure_postgres() {
  local container_id container_status health_status
  container_id="$(get_postgres_container)"
  if [[ -n "$container_id" ]]; then
    container_status="$("$container_engine" inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
    health_status="$("$container_engine" inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
    if [[ "$health_status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$container_status" == "running" || "$container_status" == "restarting" ]]; then
      wait_for_postgres
      return
    fi
  fi

  "${compose[@]}" up --detach postgres
  wait_for_postgres
}

run_standby_task() {
  local task_action="$1"
  local container_id network_name
  if [[ "$container_engine" == "podman" ]]; then
    container_id="$(get_postgres_container)"
    if [[ -z "$container_id" ]]; then
      echo "Container PostgreSQL standby tidak ditemukan." >&2
      return 1
    fi

    network_name="$(
      podman inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' \
        "$container_id" 2>/dev/null || true
    )"
    if [[ -z "$network_name" ]]; then
      echo "Jaringan internal PostgreSQL standby tidak ditemukan." >&2
      return 1
    fi

    podman run --rm \
      --name "e-posyandu-oracle-standby-task-$$" \
      --network "$network_name" \
      --user 70:70 \
      --read-only \
      --tmpfs /tmp:rw,noexec,nosuid,nodev,size=512m \
      --cap-drop all \
      --security-opt no-new-privileges \
      --pids-limit 128 \
      --memory 768m \
      --cpus 0.35 \
      --env "STANDBY_ACTION=$task_action" \
      --env STANDBY_SOURCE_URL_FILE=/run/secrets/source-database-url \
      --env STANDBY_OWNER_PASSWORD_FILE=/run/secrets/postgres-password \
      --env STANDBY_READER_PASSWORD_FILE=/run/secrets/reader-password \
      --env STANDBY_TARGET_HOST=postgres \
      --env STANDBY_TARGET_DB=eposyandu_standby \
      --env STANDBY_TARGET_OWNER=eposyandu_sync \
      --env STANDBY_TARGET_READER=eposyandu_reader \
      --volume "$container_secret_dir/source-database-url:/run/secrets/source-database-url:ro,Z" \
      --volume "$container_secret_dir/postgres-password:/run/secrets/postgres-password:ro,Z" \
      --volume "$container_secret_dir/reader-password:/run/secrets/reader-password:ro,Z" \
      --volume "$standby_dir/sync.sh:/usr/local/bin/eposyandu-standby-task:ro,Z" \
      --entrypoint /usr/local/bin/eposyandu-standby-task \
      --log-driver journald \
      docker.io/library/postgres:17.7-alpine3.23
  else
    STANDBY_ACTION="$task_action" "${compose[@]}" run --rm standby-task
  fi
}

case "$action" in
  up)
    prepare_container_secrets
    ensure_postgres
    ;;
  sync)
    prepare_container_secrets
    ensure_postgres
    run_standby_task sync
    ;;
  verify)
    prepare_container_secrets
    ensure_postgres
    run_standby_task verify
    ;;
  down)
    "${compose[@]}" down
    clear_container_secrets
    ;;
  *)
    echo "Penggunaan: $0 {up|sync|verify|down}" >&2
    exit 1
    ;;
esac
