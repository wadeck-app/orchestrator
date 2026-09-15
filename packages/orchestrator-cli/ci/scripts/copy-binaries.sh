#!/usr/bin/env bash
# Copies Go launcher, tray binaries, and bundles into platform packages AND main package.
# Usage: bash ci/scripts/copy-binaries.sh
set -euo pipefail

LAUNCHER_DIST="packages/orchestrator-cli/launcher-go/dist"
TRAY_DIST="packages/orchestrator-cli/tray-go/dist"
BUNDLE_DIST="packages/orchestrator-cli/dist-bundle"
MAIN_PKG="packages/orchestrator-cli"

# Copy binaries to platform packages
cp "$LAUNCHER_DIST/orchestrator_windows_release.exe"   packages/orchestrator-cli-win32-x64/orchestrator.exe
cp "$LAUNCHER_DIST/orchestrator_darwin_arm64_release"  packages/orchestrator-cli-darwin-arm64/orchestrator
cp "$LAUNCHER_DIST/orchestrator_darwin_amd64_release"  packages/orchestrator-cli-darwin-x64/orchestrator
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator packages/orchestrator-cli-darwin-x64/orchestrator

cp "$TRAY_DIST/orchestrator-tray.exe"   packages/orchestrator-cli-win32-x64/orchestrator-tray.exe
cp "$TRAY_DIST/orchestrator-tray-arm64" packages/orchestrator-cli-darwin-arm64/orchestrator-tray
cp "$TRAY_DIST/orchestrator-tray-amd64" packages/orchestrator-cli-darwin-x64/orchestrator-tray
chmod +x packages/orchestrator-cli-darwin-arm64/orchestrator-tray packages/orchestrator-cli-darwin-x64/orchestrator-tray

# Copy bundles + binaries to main package (like wdrive)
cp "$BUNDLE_DIST/orchestrator.cjs"         "$MAIN_PKG/orchestrator.cjs"
cp "$BUNDLE_DIST/orchestrator-cli.cjs"     "$MAIN_PKG/orchestrator-cli.cjs"
cp "$BUNDLE_DIST/orchestrator-updater.cjs" "$MAIN_PKG/orchestrator-updater.cjs"
cp "$LAUNCHER_DIST/orchestrator_windows_release.exe" "$MAIN_PKG/orchestrator.exe"
cp "$TRAY_DIST/orchestrator-tray.exe"      "$MAIN_PKG/orchestrator-tray.exe"

echo "orchestrator artifacts copied to platform packages and main package"
