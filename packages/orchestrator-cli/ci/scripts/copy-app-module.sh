#!/usr/bin/env bash
# Assembles packages/orchestrator-cli/app-module/ from the PACKAGED app-core module, so the published
# package carries it and the daemon can register it at start (src/app-core-registration.ts).
#
# app-module/manifest.json is the packaged manifest (version stamped, paths pointing at the built files),
# never the source one: app-core refuses a source manifest.
#
# Run after (see the "Build the app-core module" step of the workflow):
#   BUNDLE_VERSION=<version> npm run package --workspace=packages/app-module-orchestrator
#   (stylesheet, then `app-core-cli package` -> packages/app-module-orchestrator/dist-module/)
#
# Both CI jobs run it, so the package that is tested is the package that is published.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
packaged="$root/packages/app-module-orchestrator/dist-module"
out="$root/packages/orchestrator-cli/app-module"

require() {
  if [ ! -e "$1" ]; then
    echo "copy-app-module: $1 does not exist. $2" >&2
    exit 1
  fi
}

hint="Run: BUNDLE_VERSION=<version> npm run package --workspace=packages/app-module-orchestrator"
require "$packaged/manifest.json"            "The module is not packaged. $hint"
require "$packaged/api-backend/backend.cjs"  "$hint"
require "$packaged/dsl-lib/entries.mjs"      "$hint"
require "$packaged/dsl-lib/style.css"        "$hint (the stylesheet is built by the same command)"
require "$packaged/dsl-frontend"             "$hint"

# Rebuilt from scratch each time: a file removed from the module must not linger in the package.
rm -rf "$out"
mkdir -p "$out"
# The whole packaged folder, as `app-core-cli package` wrote it: it holds only what the manifest names plus
# the backend's sourcemap, and copying the folder (not a list of files) keeps this script right when the
# CLI adds an output.
cp -r "$packaged/." "$out/"

echo "copy-app-module: assembled ${out#"$root"/} from ${packaged#"$root"/}"
