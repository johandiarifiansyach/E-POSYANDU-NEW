#!/usr/bin/env bash
set -euo pipefail

ssh_host="${1:-}"
public_site="${2:-eposyandu.app}"

if [[ -z "$ssh_host" || ! "$ssh_host" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "Penggunaan: npm run oracle:cutover:check -- ALIAS_SSH [DOMAIN]" >&2
  exit 1
fi
if [[ ! "$public_site" =~ ^([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]]; then
  echo "Domain pemeriksaan tidak valid." >&2
  exit 1
fi

echo "[1/9] Koneksi Bastion/SSH"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$ssh_host" true

echo "[2/9] Deployment, container, dan mode API"
ssh "$ssh_host" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
test -L /opt/e-posyandu/current
test -f /opt/e-posyandu/current/deploy/oracle/compose.yaml
test -x /usr/local/sbin/eposyandu-native-mode
/usr/local/sbin/eposyandu-native-mode status
if command -v podman-compose >/dev/null 2>&1; then
  compose=(podman-compose)
else
  compose=(docker compose)
fi
"${compose[@]}" \
  --project-name e-posyandu-oracle \
  --file /opt/e-posyandu/current/deploy/oracle/compose.yaml \
  --env-file /etc/e-posyandu/nutrition-grpc.env \
  ps
REMOTE

echo "[3/9] Secret Vault tanpa menampilkan nilainya"
ssh "$ssh_host" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
host_env=/etc/e-posyandu/nutrition-grpc.env
runtime_env=/run/e-posyandu/oracle-api-vault.env
for name in \
  CLOUDFLARE_QUEUES_API_TOKEN \
  RUST_WORKER_SHARED_SECRET \
  SUPABASE_URL \
  SUPABASE_PUBLISHABLE_KEY \
  SUPABASE_SECRET_KEY \
  TURNSTILE_SECRET_KEY \
  ORACLE_API_SESSION_KEY \
  TUNNEL_TOKEN; do
  if awk -F= -v key="$name" '$1 == key && length($2) > 0 { found=1 } END { exit !found }' "$host_env"; then
    echo "Secret $name masih tersimpan di env persisten." >&2
    exit 1
  fi
done
test "$(stat -c %a /etc/e-posyandu/vault.env)" = 600
test "$(stat -c %a /run/e-posyandu/nutrition-grpc-vault.env)" = 600
test "$(stat -c %a "$runtime_env")" = 600
test "$(stat -c %a /run/e-posyandu/cloudflare-tunnel-token)" = 600
echo "Secret persisten: bersih; runtime tmpfs: siap."
REMOTE

echo "[4/9] Health API internal dan analysis-worker"
ssh "$ssh_host" 'curl --fail --silent --show-error --max-time 5 http://127.0.0.1:8081/api/v1/health/ready | python3 -c '\''import json,sys; data=json.load(sys.stdin); components=data.get("components", {}); analysis=components.get("analysisWorker", {}); print("status=" + str(data.get("status")) + " analysis-worker=" + str(analysis.get("status"))); raise SystemExit(0 if data.get("ok") is True and analysis.get("status") == "healthy" else 1)'\'''

echo "[5/9] PostgreSQL connection budget"
ssh "$ssh_host" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
env_file=/etc/e-posyandu/nutrition-grpc.env
target="$(sed -n 's/^ORACLE_POSTGRES_API_ROLE_CONNECTION_LIMIT=//p' "$env_file" | tail -n 1)"
target="${target:-40}"
if [[ ! "$target" =~ ^[0-9]+$ ]] || (( target < 10 || target > 90 )); then
  echo "Budget koneksi PostgreSQL harus berupa angka 10..90." >&2
  exit 1
fi
role_limit="$(runuser -u postgres -- psql --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="select rolconnlimit from pg_roles where rolname='eposyandu_api';")"
role_limit="${role_limit//[[:space:]]/}"
max_connections="$(runuser -u postgres -- psql --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --command='show max_connections;')"
max_connections="${max_connections//[[:space:]]/}"
if [[ -z "$role_limit" || ! "$role_limit" =~ ^-?[0-9]+$ ]]; then
  echo "Role eposyandu_api tidak ditemukan atau rolconnlimit tidak valid." >&2
  exit 1
fi
if (( role_limit != -1 && role_limit < target )); then
  echo "Role eposyandu_api hanya memiliki limit $role_limit (minimum $target)." >&2
  exit 1
fi
if (( role_limit != -1 )) && { [[ ! "$max_connections" =~ ^[0-9]+$ ]] || (( target >= max_connections - 4 )); }; then
  echo "Budget koneksi $target terlalu besar untuk max_connections=$max_connections." >&2
  exit 1
fi
active="$(runuser -u postgres -- psql --dbname=postgres --no-psqlrc --set=ON_ERROR_STOP=1 --tuples-only --no-align --command="select count(*) from pg_stat_activity where usename='eposyandu_api';")"
active="${active//[[:space:]]/}"
if [[ ! "$active" =~ ^[0-9]+$ ]]; then
  echo "Jumlah koneksi aktif PostgreSQL tidak valid." >&2
  exit 1
fi
if (( role_limit != -1 && active >= role_limit )); then
  echo "Koneksi aktif eposyandu_api ($active) sudah mencapai limit $role_limit." >&2
  exit 1
fi
echo "Role eposyandu_api: limit=$role_limit aktif=$active max_connections=$max_connections."
REMOTE

echo "[6/9] Cloudflare Tunnel dan penutupan bind origin"
ssh "$ssh_host" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
env_file=/etc/e-posyandu/nutrition-grpc.env
profiles="$(sed -n 's/^COMPOSE_PROFILES=//p' "$env_file" | tail -n 1)"
public_bind="$(sed -n 's/^ORACLE_PUBLIC_BIND=//p' "$env_file" | tail -n 1)"
case ",${profiles// /,}," in
  *,cloudflare-tunnel,*)
    test -s /run/e-posyandu/cloudflare-tunnel-token
    test "$public_bind" = "127.0.0.1"
    curl --fail --silent --show-error --max-time 5 \
      http://127.0.0.1:2000/ready >/dev/null
    echo "Tunnel aktif; origin hanya bind ke loopback."
    ;;
  *)
    echo "Tunnel belum diaktifkan; origin masih dalam fase transisi."
    ;;
esac
REMOTE

echo "[7/9] Timer operasional"
ssh "$ssh_host" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
for unit in \
  eposyandu-oci-metrics.timer \
  eposyandu-backup.timer \
  eposyandu-postgresql-backup.timer; do
  systemctl is-enabled --quiet "$unit"
done
echo "Monitoring dan backup: siap."
REMOTE

echo "[8/9] HTTPS publik dan security headers"
headers="$(curl --fail --silent --show-error --max-time 15 --head "https://$public_site/")"
grep -Eiq '^strict-transport-security:' <<<"$headers"
grep -Eiq '^content-security-policy:' <<<"$headers"
grep -Eiq '^x-content-type-options:[[:space:]]*nosniff' <<<"$headers"
echo "HTTPS dan header utama: siap."

echo "[9/9] Delegasi DNS edge"
nameservers="$(dig +short NS "$public_site" | tr '[:upper:]' '[:lower:]')"
if grep -q 'cloudflare.com' <<<"$nameservers"; then
  echo "Nameserver Cloudflare: aktif."
  grep -Eiq '^server:[[:space:]]*cloudflare' <<<"$headers"
  grep -Eiq '^cf-ray:' <<<"$headers"
  echo "Proxy Cloudflare: terbukti aktif."
else
  echo "PERINGATAN: nameserver masih belum didelegasikan ke Cloudflare." >&2
  printf '%s\n' "$nameservers" >&2
fi

echo "Preflight Oracle selesai tanpa membuka secret atau data kesehatan."
