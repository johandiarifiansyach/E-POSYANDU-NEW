#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
label="com.eposyandu.nutrition-grpc"
env_file="$HOME/.config/e-posyandu/nutrition-grpc.env"
agent_file="$HOME/Library/LaunchAgents/$label.plist"
log_dir="$HOME/Library/Logs/EPosyandu"
install_dir="$HOME/Library/Application Support/EPosyandu/nutrition-grpc"
installed_binary="$install_dir/e-posyandu-nutrition-grpc"
installed_runner="$install_dir/run-nutrition-grpc.sh"
uid="$(id -u)"

for name in CLOUDFLARE_QUEUES_API_TOKEN RUST_WORKER_SHARED_SECRET; do
  value="$(sed -n "s/^${name}=//p" "$env_file" 2>/dev/null | tail -n 1)"
  if [[ -z "$value" || "$value" == replace-* ]]; then
    echo "Isi $name pada $env_file sebelum memasang layanan." >&2
    exit 1
  fi
done

cargo build --locked --release --manifest-path "$project_root/services/nutrition-grpc/Cargo.toml"
mkdir -p "$HOME/Library/LaunchAgents" "$log_dir" "$install_dir"
install -m 755 \
  "$project_root/services/nutrition-grpc/target/release/nutrition-grpc-standalone" \
  "$installed_binary"
install -m 755 "$project_root/scripts/services/run-nutrition-grpc.sh" "$installed_runner"

sed \
  -e "s|__HOME__|$HOME|g" \
  -e "s|__INSTALL_DIR__|$install_dir|g" \
  "$project_root/services/nutrition-grpc/com.eposyandu.nutrition-grpc.plist.template" \
  > "$agent_file"
chmod 600 "$agent_file"

launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$agent_file"
launchctl enable "gui/$uid/$label"
launchctl kickstart -k "gui/$uid/$label"

echo "Layanan $label aktif."
echo "Log: $log_dir/nutrition-grpc.log"
