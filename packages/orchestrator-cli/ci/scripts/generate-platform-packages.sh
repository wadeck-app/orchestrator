#!/usr/bin/env bash
# Generates all platform package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash ci/scripts/generate-platform-packages.sh
set -euo pipefail

REGISTRY="https://npm.pkg.github.com/"

generate_platform() {
  local name="$1" os="$2" cpu="$3" launcher_bin="$4" tray_bin="$5" supervisor_bin="$6"
  local dir="packages/${name}"
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck-app/${name}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["${launcher_bin}", "${tray_bin}", "${supervisor_bin}"],
  "publishConfig": {
    "@wadeck-app:registry": "${REGISTRY}"
  }
}
EOF
  echo "generated $dir/package.json"
}

generate_platform "orchestrator-cli-win32-x64"    "win32"  "x64"   "orchestrator.exe"  "orchestrator-tray.exe" "orchestrator-supervisor.exe"
generate_platform "orchestrator-cli-darwin-arm64" "darwin" "arm64" "orchestrator"       "orchestrator-tray" "orchestrator-supervisor"
generate_platform "orchestrator-cli-darwin-x64"   "darwin" "x64"   "orchestrator"       "orchestrator-tray" "orchestrator-supervisor"
