#!/usr/bin/env bash
# Generates all platform package directories for npm publish.
# Called by CI before copy-binaries.sh. Not needed locally.
# Usage: bash ci/scripts/generate-platform-packages.sh
set -euo pipefail

REGISTRY="https://npm.pkg.github.com/"

generate_platform() {
  # tray_bin is empty where there is no systray build (Linux): the package then lists two files.
  local name="$1" os="$2" cpu="$3" tray_bin="$4" supervisor_bin="$5"
  local dir="packages/${name}"
  local files="\"${supervisor_bin}\""
  if [ -n "$tray_bin" ]; then
    files="\"${tray_bin}\", \"${supervisor_bin}\""
  fi
  mkdir -p "$dir"
  cat > "$dir/package.json" <<EOF
{
  "name": "@wadeck-app/${name}",
  "version": "0.0.0",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": [${files}],
  "publishConfig": {
    "@wadeck-app:registry": "${REGISTRY}"
  }
}
EOF
  echo "generated $dir/package.json"
}

generate_platform "orchestrator-cli-win32-x64"    "win32"  "x64"   "orchestrator-tray.exe" "orchestrator-supervisor.exe"
generate_platform "orchestrator-cli-darwin-arm64" "darwin" "arm64" "orchestrator-tray"     "orchestrator-supervisor"
generate_platform "orchestrator-cli-linux-x64"    "linux"  "x64"   ""                      "orchestrator-supervisor"
