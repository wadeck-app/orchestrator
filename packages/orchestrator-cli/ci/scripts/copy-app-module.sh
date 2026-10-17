#!/usr/bin/env bash
# Assembles packages/orchestrator-cli/app-module/ from the built app-core module, so the published
# package carries it and the daemon can register it at start (src/app-core-registration.ts).
#
# Run after:
#   npm run build --workspace=packages/orch-dsl-lib           (components + stylesheet -> dsl-lib/)
#   npm run build --workspace=packages/app-module-orchestrator (backend -> api-backend/dist/)
#
# Both CI jobs run it, so the package that is tested is the package that is published.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
module="$root/packages/app-module-orchestrator"
out="$root/packages/orchestrator-cli/app-module"

require() {
  if [ ! -e "$1" ]; then
    echo "copy-app-module: $1 does not exist. $2" >&2
    exit 1
  fi
}

require "$module/manifest.json"                     "The module's manifest is missing."
require "$module/api-backend/dist/backend.mjs"     "Run: npm run build --workspace=packages/app-module-orchestrator"
require "$module/dsl-lib/entries.mjs"              "Run: npm run build --workspace=packages/orch-dsl-lib"
require "$module/dsl-lib/style.css"                "Run: npm run build --workspace=packages/orch-dsl-lib"
require "$module/dsl-frontend"                     "The module's pages are missing."

# Rebuilt from scratch each time: a file removed from the module must not linger in the package.
rm -rf "$out"
mkdir -p "$out/api-backend/dist"
cp "$module/manifest.json" "$out/manifest.json"
# Only the file the manifest's backendEntryPath names, not the folder: it is one self-contained bundle,
# and copying a folder would ship whatever stale file an earlier local build left in it.
cp "$module/api-backend/dist/backend.mjs" "$out/api-backend/dist/backend.mjs"
cp -r "$module/dsl-frontend" "$out/dsl-frontend"
cp -r "$module/dsl-lib" "$out/dsl-lib"

echo "copy-app-module: assembled ${out#"$root"/}"
