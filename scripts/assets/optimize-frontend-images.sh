#!/usr/bin/env bash
set -euo pipefail

# Build-time image optimization for the React frontend. Generated files are
# deployed as static assets so the API never resizes images on a request path.
if ! command -v cwebp >/dev/null 2>&1; then
  echo "cwebp tidak ditemukan. Pasang WebP tools sebelum menjalankan skrip ini." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
poster_dir="$repo_root/frontend-react/public/education/posters"
source_dir="$repo_root/frontend-react/assets/source-images"

for source in \
  isi-piringku-2-5.jpg \
  isi-piringku-6-8.jpg \
  isi-piringku-9-11.jpg \
  isi-piringku-12-23.jpg; do
  target="${source%.jpg}.webp"
  cwebp -quiet -resize 1200 0 -q 82 -m 6 "$source_dir/$source" -o "$poster_dir/$target"
done

# Keep the login background bounded for mobile and desktop displays.
cwebp -quiet -resize 1600 0 -q 82 -m 6 \
  "$source_dir/batik-jember-login.jpg" \
  -o "$repo_root/frontend-react/public/batik-jember-login.webp"

echo "Optimasi WebP selesai di frontend-react/public."
