#!/usr/bin/env bash
# Copies Go launcher and tray binaries into platform packages.
# Usage: bash ci/scripts/copy-binaries.sh
set -euo pipefail

LAUNCHER_DIST="launcher-go/dist"
TRAY_DIST="tray-go/dist"

cp "$LAUNCHER_DIST/orchestrator_windows_release.exe"   packages/orchestrator-cli-win32-x64/orchestrator.exe
cp "$LAUNCHER_DIST/orchestrator_darwin_arm64_release"  packages/orchestrator-cli-darwin-arm64/orchestrator
cp "$LAUNCHER_DIST/orchestrator_darwin_amd64_release"  packages/orchestrator-cli-darwin-x64/orchestrator
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator packages/orchestrator-cli-darwin-x64/orchestrator

cp "$TRAY_DIST/orchestrator-tray.exe"   packages/orchestrator-cli-win32-x64/orchestrator-tray.exe
cp "$TRAY_DIST/orchestrator-tray-arm64" packages/orchestrator-cli-darwin-arm64/orchestrator-tray
cp "$TRAY_DIST/orchestrator-tray-amd64" packages/orchestrator-cli-darwin-x64/orchestrator-tray
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator-tray packages/orchestrator-cli-darwin-x64/orchestrator-tray

echo "orchestrator artifacts copied"
