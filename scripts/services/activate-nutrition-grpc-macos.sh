#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
env_file="$HOME/.config/e-posyandu/nutrition-grpc.env"

if [[ ! -f "$env_file" ]]; then
  echo "Konfigurasi tidak ditemukan: $env_file" >&2
  exit 1
fi

account_id="$(sed -n 's/^CLOUDFLARE_ACCOUNT_ID=//p' "$env_file" | tail -n 1)"
queue_id="$(sed -n 's/^CLOUDFLARE_QUEUE_ID=//p' "$env_file" | tail -n 1)"

queue_token="$(osascript <<'APPLESCRIPT'
try
  text returned of (display dialog "Tempel Cloudflare Queue API Token baru" default answer "" with hidden answer buttons {"Batal", "Aktifkan"} default button "Aktifkan" cancel button "Batal" with title "Aktivasi E-Posyandu")
on error number -128
  return ""
end try
APPLESCRIPT
)"

if [[ -z "$queue_token" ]]; then
  echo "Aktivasi dibatalkan atau token kosong." >&2
  exit 1
fi

response="$(curl --silent --show-error --fail \
  --header "Authorization: Bearer $queue_token" \
  "https://api.cloudflare.com/client/v4/accounts/$account_id/queues/$queue_id" || true)"

if ! printf '%s' "$response" | grep -Eq '"success"[[:space:]]*:[[:space:]]*true'; then
  echo "Token belum memiliki izin Account > Queues > Edit untuk akun ini." >&2
  exit 1
fi
unset response

escaped_token="$(printf '%s' "$queue_token" | sed 's/[&|\\]/\\&/g')"
sed "s|^CLOUDFLARE_QUEUES_API_TOKEN=.*$|CLOUDFLARE_QUEUES_API_TOKEN=$escaped_token|" \
  "$env_file" > "$env_file.next"
chmod 600 "$env_file.next"
mv "$env_file.next" "$env_file"
unset queue_token escaped_token

if lsof -tiTCP:50051 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 50051 masih dipakai proses lain. Hentikan proses itu lalu jalankan kembali." >&2
  exit 1
fi

"$project_root/scripts/services/install-nutrition-grpc-macos.sh"

echo "Aktivasi selesai. Rust gRPC worker kini berjalan sebagai layanan macOS."
