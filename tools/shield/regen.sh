#!/usr/bin/env bash
# Shield seed regenerator — fetch the upstream filter lists and rebuild the five
# vendored seed artifacts under src-tauri/src/blocker/seed/.
#
# Run before cutting a release. hosts.txt + cosmetics.css also refresh at runtime
# (lists.rs / Plan SF4b), but content_filter_*.json + scriptlets.json refresh
# ONLY here — their WebKit-safe-regex / scriptlet conversion is offline-only.
#
# Usage:
#   tools/shield/regen.sh             # rebuild the committed seed in place
#   tools/shield/regen.sh /tmp/out    # write elsewhere (verification / dry run)
#
# Fetches succeed-or-abort (curl -f, set -e): a network failure leaves the
# committed seed untouched, since gen_seed.py only runs after all fetches land.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SEED_DIR="$(cd "$SCRIPT_DIR/../../src-tauri/src/blocker/seed" && pwd)"
OUT_DIR="${1:-$SEED_DIR}"
DATE="$(date +%F)"

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# name -> URL. easylist/easyprivacy feed hosts + cosmetics + content-filter;
# the ubo-* lists feed scriptlets (processed in this order — see gen_seed.py).
fetch() {
  local name="$1" url="$2"
  curl -fsSL --max-time 60 "$url" -o "$WORK/$name"
  printf "  %-24s %9d bytes\n" "$name" "$(wc -c < "$WORK/$name")"
}

echo "Fetching upstream lists -> $WORK"
fetch easylist.txt            "https://easylist.to/easylist/easylist.txt"
fetch easyprivacy.txt         "https://easylist.to/easylist/easyprivacy.txt"
fetch ubo-filters.txt         "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/filters.txt"
fetch ubo-privacy.txt         "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/privacy.txt"
fetch ubo-quick-fixes.txt     "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/quick-fixes.txt"
fetch ubo-badware.txt         "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt"
fetch ubo-resource-abuse.txt  "https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/resource-abuse.txt"

echo "Generating seed -> $OUT_DIR"
python3 "$SCRIPT_DIR/gen_seed.py" "$WORK" "$OUT_DIR" "$DATE"
echo "Done."
