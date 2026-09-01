#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
label="com.eposyandu.data-processing-worker"
env_file="$HOME/.config/e-posyandu/data-processing-worker.env"
if [[ ! -f "$env_file" && -f "$HOME/.config/e-posyandu/nutrition-grpc.env" ]]; then
  # Compatibility for installations created before the service rename.
  env_file="$HOME/.config/e-posyandu/nutrition-grpc.env"
fi
agent_file="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/EPosyandu"
install_dir="$HOME/Library/Application Support/EPosyandu/data-processing-worker"
installed_binary="$install_dir/data-processing-worker"
installed_runner="$install_dir/run-data-processing-worker.sh"
uid="$(id -u)"

for name in CLOUDFLARE_QUEUES_API_TOKEN RUST_WORKER_SHARED_SECRET; do
  value="$(sed -n "s/^${name}=//p" "$env_file" 2>/dev/null | tail -n 1)"
  if [[ -z "$value" || "$value" == replace-* ]]; then
    echo "Isi $name pada $env_file sebelum memasang layanan." >&2
    exit 1
  fi
done

cargo build --locked --release --manifest-path "$project_root/services/data-processing-service/Cargo.toml"
mkdir -p "$HOME/Library/LaunchAgents" "$log_dir" "$install_dir"
install -m 755 \
  "$project_root/services/data-processing-service/target/release/data-processing-worker" \
  "$installed_binary"
install -m 755 "$project_root/scripts/services/run-data-processing-worker.sh" "$installed_runner"

sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__INSTALL_DIR__|$install_dir|g" \
  "$project_root/services/data-processing-service/com.eposyandu.data-processing-worker.plist.template" \
  > "$agent_file"
chmod 600 "$agent_file"

launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$agent_file"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"

echo "Layanan $label aktif."
echo "Log: $log_dir/data-processing-worker.log"
