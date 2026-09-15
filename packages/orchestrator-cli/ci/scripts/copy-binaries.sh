#!/usr/bin/env bash
# Copies Go launcher and tray binaries into the platform packages.
#
# The main package deliberately ships NO native binary: the daemon resolves the tray
# through require.resolve('<platformPkg>/orchestrator-tray*'), and the Go launcher finds
# its bundle via the relative nodeScript in ci/launcher.config.json. Copying the Windows
# binaries into the main package would make every macOS user download ~9 MB of unusable
# .exe files.
#
# Usage: bash ci/scripts/copy-binaries.sh
set -euo pipefail

LAUNCHER_DIST="packages/orchestrator-cli/launcher-go/dist"
TRAY_DIST="packages/orchestrator-cli/tray-go/dist"

cp "$LAUNCHER_DIST/orchestrator_windows_release.exe"   packages/orchestrator-cli-win32-x64/orchestrator.exe
cp "$LAUNCHER_DIST/orchestrator_darwin_arm64_release"  packages/orchestrator-cli-darwin-arm64/orchestrator
cp "$LAUNCHER_DIST/orchestrator_darwin_amd64_release"  packages/orchestrator-cli-darwin-x64/orchestrator
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator packages/orchestrator-cli-darwin-x64/orchestrator

cp "$TRAY_DIST/orchestrator-tray.exe"   packages/orchestrator-cli-win32-x64/orchestrator-tray.exe
cp "$TRAY_DIST/orchestrator-tray-arm64" packages/orchestrator-cli-darwin-arm64/orchestrator-tray
cp "$TRAY_DIST/orchestrator-tray-amd64" packages/orchestrator-cli-darwin-x64/orchestrator-tray
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator-tray packages/orchestrator-cli-darwin-x64/orchestrator-tray

echo "orchestrator native binaries copied to platform packages"
