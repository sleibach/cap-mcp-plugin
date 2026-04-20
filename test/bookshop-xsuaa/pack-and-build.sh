#!/usr/bin/env bash
# Build an MTA archive that bundles the local @gavdi/cap-mcp source.
#
# Why this script exists: package.json points at the plugin via
#   "@gavdi/cap-mcp": "file:../.."
# which works for local `cds watch` but the path is not valid inside
# the MTA build context (gen/srv gets packaged in isolation). This
# script packs the plugin, drops the tarball into the sample, and
# rewrites gen/srv/package.json to install from it.
#
# Usage: ./pack-and-build.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HERE/../.." && pwd)"

echo "==> pack @gavdi/cap-mcp from $PLUGIN_ROOT"
cd "$PLUGIN_ROOT"
TGZ=$(npm pack --silent | tail -1)
mv "$TGZ" "$HERE/$TGZ"
cd "$HERE"
echo "==> tarball: $HERE/$TGZ"

echo "==> cds build --production"
cds build --production

echo "==> copy tarball into gen/srv and rewrite package.json"
cp "$HERE/$TGZ" "$HERE/gen/srv/$TGZ"
node -e "
  const fs = require('fs');
  const path = './gen/srv/package.json';
  const pkg = JSON.parse(fs.readFileSync(path));
  pkg.dependencies['@gavdi/cap-mcp'] = 'file:./$TGZ';
  fs.writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
"

if ! command -v mbt >/dev/null 2>&1; then
  echo "ℹ  mbt not found — skipping 'mbt build'. Install: npm i -g mbt"
  echo "   You can still manually run:  mbt build -t gen/"
  exit 0
fi

echo "==> mbt build"
mbt build -t gen/

echo
echo "Done. Next steps:"
echo "  cf login ..."
echo "  cf deploy gen/*.mtar"
