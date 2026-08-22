#!/usr/bin/env bash
set -euo pipefail

archive_file="${1:-}"
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Installer standby harus dijalankan sebagai root." >&2
  exit 1
fi
if [[ ! -f "$archive_file" ]]; then
  echo "Archive standby tidak ditemukan." >&2
  exit 1
fi

while IFS= read -r archive_entry; do
  case "$archive_entry" in
    /*|../*|*/../*)
      echo "Archive standby memiliki path yang tidak aman." >&2
      exit 1
      ;;
  esac
done < <(tar -tzf "$archive_file")

install -d -o root -g root -m 0750 /opt/e-posyandu/standby /usr/local/libexec/e-posyandu
temporary_dir="$(mktemp -d /tmp/eposyandu-standby-install.XXXXXX)"
trap 'rm -rf "$temporary_dir"' EXIT
tar -xzf "$archive_file" --no-same-owner -C "$temporary_dir"
if [[ ! -f "$temporary_dir/vault/eposyandu-vault-env.py" ]]; then
  echo "Materializer OCI Vault tidak ada dalam archive standby." >&2
  exit 1
fi
install -o root -g root -m 0750 \
  "$temporary_dir/vault/eposyandu-vault-env.py" \
  /usr/local/libexec/e-posyandu/eposyandu-vault-env.py
systemctl restart eposyandu-vault-env.service
for required_file in \
  /run/e-posyandu/oracle-standby-source-database-url \
  /run/e-posyandu/oracle-standby-postgres-password \
  /run/e-posyandu/oracle-standby-reader-password; do
  if [[ ! -s "$required_file" ]]; then
    echo "Secret runtime standby belum tersedia: $required_file" >&2
    echo "Isi ketiga OCID secret standby pada /etc/e-posyandu/vault.env." >&2
    exit 1
  fi
done

install -o root -g root -m 0640 "$temporary_dir/standby/compose.yaml" /opt/e-posyandu/standby/compose.yaml
install -o root -g root -m 0755 "$temporary_dir/standby/init-reader.sh" /opt/e-posyandu/standby/init-reader.sh
install -o root -g root -m 0755 "$temporary_dir/standby/sync.sh" /opt/e-posyandu/standby/sync.sh
install -o root -g root -m 0750 \
  "$temporary_dir/standby/eposyandu-oracle-standby.sh" \
  /usr/local/libexec/e-posyandu/eposyandu-oracle-standby
install -o root -g root -m 0644 \
  "$temporary_dir/standby/eposyandu-oracle-standby.service" \
  /etc/systemd/system/eposyandu-oracle-standby.service
install -o root -g root -m 0644 \
  "$temporary_dir/standby/eposyandu-oracle-standby-sync.service" \
  /etc/systemd/system/eposyandu-oracle-standby-sync.service
install -o root -g root -m 0644 \
  "$temporary_dir/standby/eposyandu-oracle-standby-sync.timer" \
  /etc/systemd/system/eposyandu-oracle-standby-sync.timer

systemctl daemon-reload
systemctl disable --now eposyandu-oracle-standby-sync.timer >/dev/null 2>&1 || true
systemctl stop eposyandu-oracle-standby.service >/dev/null 2>&1 || true
systemctl enable eposyandu-oracle-standby.service
systemctl restart eposyandu-oracle-standby.service
systemctl start eposyandu-oracle-standby-sync.service
/usr/local/libexec/e-posyandu/eposyandu-oracle-standby verify
systemctl enable --now eposyandu-oracle-standby-sync.timer
echo "PostgreSQL standby Oracle aktif dan sinkronisasi 15 menit terpasang."
