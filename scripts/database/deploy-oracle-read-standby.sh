#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ssh_host="${1:-}"
if [[ -z "$ssh_host" || ! "$ssh_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Penggunaan: npm run oracle:standby:deploy -- ALIAS_SSH" >&2
  exit 1
fi

temporary_dir="$(mktemp -d)"
remote_stage=""
cleanup() {
  rm -rf -- "$temporary_dir"
  if [[ -n "$remote_stage" && "$remote_stage" == /tmp/eposyandu-standby.* ]]; then
    ssh "$ssh_host" "rm -rf -- '$remote_stage'" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

archive_file="$temporary_dir/e-posyandu-oracle-standby.tar.gz"
COPYFILE_DISABLE=1 tar \
  --no-xattrs \
  --no-mac-metadata \
  --no-fflags \
  -czf "$archive_file" \
  -C "$project_root/deploy/oracle" \
  standby vault/eposyandu-vault-env.py

ssh -o BatchMode=yes -o ConnectTimeout=15 "$ssh_host" true
remote_stage="$(ssh "$ssh_host" 'mktemp -d /tmp/eposyandu-standby.XXXXXX')"
if [[ "$remote_stage" != /tmp/eposyandu-standby.* ]]; then
  echo "Direktori sementara Oracle tidak valid." >&2
  exit 1
fi
scp -q "$archive_file" "$ssh_host:$remote_stage/"
ssh "$ssh_host" \
  "tar -xOf '$remote_stage/e-posyandu-oracle-standby.tar.gz' standby/install.sh > '$remote_stage/install.sh' && chmod 700 '$remote_stage/install.sh' && sudo '$remote_stage/install.sh' '$remote_stage/e-posyandu-oracle-standby.tar.gz'"

echo "Deployment PostgreSQL standby Oracle selesai."
