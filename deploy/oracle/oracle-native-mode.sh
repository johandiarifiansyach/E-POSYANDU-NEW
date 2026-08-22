#!/usr/bin/env bash
set -euo pipefail

mode="${1:-status}"
env_file="/etc/e-posyandu/nutrition-grpc.env"
runtime_env="/run/e-posyandu/oracle-api-vault.env"
compose_file="/opt/e-posyandu/current/deploy/oracle/compose.yaml"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Jalankan melalui sudo/root." >&2
  exit 1
fi

case "$mode" in
  status|proxy|auth|reads|full|rollback) ;;
  *)
    echo "Penggunaan: eposyandu-native-mode {status|proxy|auth|reads|full|rollback}" >&2
    exit 1
    ;;
esac

if [[ ! -f "$env_file" || ! -f "$compose_file" ]]; then
  echo "Deployment Oracle aktif belum ditemukan." >&2
  exit 1
fi

read_flag() {
  local name="$1"
  local fallback="${2:-false}"
  local value
  value="$(sed -n "s/^${name}=//p" "$env_file" | tail -n 1)"
  if [[ "$value" == "true" ]]; then
    printf 'true'
  elif [[ "$value" == "false" ]]; then
    printf 'false'
  else
    printf '%s' "$fallback"
  fi
}

show_status() {
  printf 'native_auth=%s\n' "$(read_flag ORACLE_API_NATIVE_AUTH_ENABLED)"
  printf 'native_reads=%s\n' "$(read_flag ORACLE_API_NATIVE_READS_ENABLED)"
  printf 'native_writes=%s\n' "$(read_flag ORACLE_API_NATIVE_WRITES_ENABLED)"
  printf 'migration_proxy=%s\n' "$(read_flag ORACLE_API_MIGRATION_PROXY_ENABLED true)"
  if [[ -s "$runtime_env" ]]; then
    printf 'vault_runtime=ready\n'
  else
    printf 'vault_runtime=missing\n'
  fi
}

if [[ "$mode" == "status" ]]; then
  show_status
  exit 0
fi

if [[ "$mode" == "rollback" ]]; then
  mode="proxy"
fi

if [[ "$mode" != "proxy" ]]; then
  required_secret_names=(
    SUPABASE_URL
    SUPABASE_PUBLISHABLE_KEY
    SUPABASE_SECRET_KEY
    TURNSTILE_SECRET_KEY
    ORACLE_API_SESSION_KEY
  )
  if [[ ! -s "$runtime_env" ]]; then
    echo "Secret runtime Oracle API belum tersedia dari OCI Vault." >&2
    exit 1
  fi
  for secret_name in "${required_secret_names[@]}"; do
    if ! awk -F= -v key="$secret_name" '$1 == key && length($2) > 0 { found=1 } END { exit !found }' "$runtime_env"; then
      echo "Secret runtime $secret_name belum tersedia dari OCI Vault." >&2
      exit 1
    fi
  done
fi

case "$mode" in
  proxy)
    auth=false
    reads=false
    writes=false
    ;;
  auth)
    auth=true
    reads=false
    writes=false
    ;;
  reads)
    auth=true
    reads=true
    writes=false
    ;;
  full)
    auth=true
    reads=true
    writes=true
    ;;
esac

set_env_value() {
  local name="$1"
  local value="$2"
  local input="$3"
  local output="$4"
  awk -F= -v name="$name" -v value="$value" '
    BEGIN { written=0 }
    $1 == name {
      if (!written) print name "=" value
      written=1
      next
    }
    { print }
    END { if (!written) print name "=" value }
  ' "$input" > "$output"
}

work_dir="$(mktemp -d /etc/e-posyandu/.native-mode.XXXXXX)"
backup_file="$work_dir/original.env"
cp --preserve=mode,ownership "$env_file" "$backup_file"
trap 'rm -rf -- "$work_dir"' EXIT

current="$backup_file"
for assignment in \
  "ORACLE_API_NATIVE_AUTH_ENABLED=$auth" \
  "ORACLE_API_NATIVE_READS_ENABLED=$reads" \
  "ORACLE_API_NATIVE_WRITES_ENABLED=$writes" \
  "ORACLE_API_MIGRATION_PROXY_ENABLED=true"; do
  name="${assignment%%=*}"
  value="${assignment#*=}"
  next="$work_dir/$name.env"
  set_env_value "$name" "$value" "$current" "$next"
  current="$next"
done
install -o root -g root -m 0600 "$current" "$env_file"

if command -v podman-compose >/dev/null 2>&1; then
  compose=(podman-compose)
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
else
  echo "Compose runtime tidak ditemukan." >&2
  install -o root -g root -m 0600 "$backup_file" "$env_file"
  exit 1
fi

restart_api() {
  "${compose[@]}" \
    --project-name e-posyandu-oracle \
    --file "$compose_file" \
    --env-file "$env_file" \
    up --detach --force-recreate --remove-orphans >/dev/null
}

if ! restart_api; then
  install -o root -g root -m 0600 "$backup_file" "$env_file"
  restart_api || true
  echo "Gagal menjalankan Oracle API; mode sebelumnya telah dipulihkan." >&2
  exit 1
fi

ready=false
for _ in $(seq 1 30); do
  response="$(curl --silent --show-error --max-time 3 http://127.0.0.1:8081/api/v1/health/ready 2>/dev/null || true)"
  if python3 -c '
import json, sys
payload = json.load(sys.stdin)
components = payload.get("components", {})
auth = components.get("authentication", {})
native = components.get("nativeCore", {})
mode = sys.argv[1]
if mode == "proxy":
    valid = payload.get("ok") is True
elif mode == "auth":
    valid = payload.get("ok") is True and auth.get("configured") is True and auth.get("origin") == "oracle-native"
elif mode == "reads":
    valid = payload.get("ok") is True and native.get("enabled") is True and native.get("reads") is True and native.get("writes") is False and auth.get("origin") == "oracle-native"
else:
    valid = payload.get("ok") is True and native.get("enabled") is True and native.get("reads") is True and native.get("writes") is True and auth.get("origin") == "oracle-native"
raise SystemExit(0 if valid else 1)
' "$mode" <<<"$response" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 2
done

if [[ "$ready" != true ]]; then
  install -o root -g root -m 0600 "$backup_file" "$env_file"
  restart_api || true
  echo "Readiness gagal; mode sebelumnya telah dipulihkan." >&2
  if [[ -n "$response" ]]; then
    echo "Respons readiness: $response" >&2
  fi
  exit 1
fi

echo "Mode Oracle API berhasil diubah ke: $mode"
show_status
