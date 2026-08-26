#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$script_dir/deploy-oracle-nutrition-worker.sh" "${1:-}" "${2:-}" identity-service
