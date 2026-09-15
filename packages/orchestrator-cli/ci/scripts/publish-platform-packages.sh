#!/usr/bin/env bash
# Publishes the platform packages only when the native binaries actually changed, then
# pins their EXACT versions into the main package.
#
# The platform version carries the binary hash as a suffix:
#   2026.9.15-243-cd97dfa4-bin.a1b2c3d4e5f6
# If a published version already carries the current hash, it is reused as-is and no
# publish happens, so the version sequence gets gaps that document binary changes.
#
# Why an EXACT pin rather than a range: with ">=0.0.0-0" any installed version satisfies
# the range, so npm never touches the platform package and the daemon ends up running new
# JS against old binaries. With an exact pin, `npm install -g main@X` updates the platform
# package in the same transaction iff the pin moved, and a rollback to an older main
# restores the binaries that main was built against. `os`/`cpu` on the platform packages
# keep npm from downloading the other platforms.
#
# One hash covers ALL binaries: they come from the same toolchain and always change
# together, so a shared version keeps the three platform packages and their gaps aligned.
#
# Usage: bash ci/scripts/publish-platform-packages.sh <version> <dist_tag>
set -euo pipefail

VERSION="${1:?missing version}"
DIST_TAG="${2:?missing dist tag}"

LAUNCHER_DIST="packages/orchestrator-cli/launcher-go/dist"
TRAY_DIST="packages/orchestrator-cli/tray-go/dist"
MAIN_PKG="packages/orchestrator-cli"

BIN_HASH=$(cat \
  "$LAUNCHER_DIST/orchestrator_windows_release.exe" \
  "$LAUNCHER_DIST/orchestrator_darwin_arm64_release" \
  "$LAUNCHER_DIST/orchestrator_darwin_amd64_release" \
  "$TRAY_DIST/orchestrator-tray.exe" \
  "$TRAY_DIST/orchestrator-tray-arm64" \
  "$TRAY_DIST/orchestrator-tray-amd64" \
  | sha256sum | cut -c1-12)

echo "native binary hash: $BIN_HASH"

for p in win32-x64 darwin-arm64 darwin-x64; do
  PKG="@wadeck-app/orchestrator-cli-$p"
  DIR="packages/orchestrator-cli-$p"

  # Newest already-published version carrying this exact hash, if any.
  # With --json, npm writes an error document to stdout and exits non-zero. A missing
  # package (E404) is the legitimate first-publish case; anything else must fail the build
  # rather than silently republish and move the pin for no reason.
  set +e
  PUBLISHED=$(npm view "$PKG" versions --json 2>/dev/null)
  RC=$?
  set -e
  if [ "$RC" -ne 0 ]; then
    if printf '%s' "$PUBLISHED" | jq -e '.error.code == "E404"' >/dev/null 2>&1; then
      echo "$PKG: not published yet -> first publish"
      PUBLISHED='[]'
    else
      echo "ERROR: 'npm view $PKG versions' failed (exit $RC):" >&2
      printf '%s\n' "$PUBLISHED" >&2
      exit 1
    fi
  fi

  PIN=$(printf '%s' "$PUBLISHED" | jq -r --arg h "$BIN_HASH" \
    '[ (if type == "array" then .[] else . end)
       | select(type == "string")
       | select(endswith("-bin." + $h)) ] | last // empty')

  if [ -n "$PIN" ]; then
    echo "$PKG: binaries unchanged -> reusing $PIN (no publish)"
  else
    PIN="$VERSION-bin.$BIN_HASH"
    echo "$PKG: binaries changed -> publishing $PIN"
    (cd "$DIR" && npm pkg set version="$PIN" && npm publish --tag "$DIST_TAG")
  fi

  npm pkg set "optionalDependencies.$PKG=$PIN" --workspace="$MAIN_PKG"
done

echo "pinned platform packages:"
npm pkg get optionalDependencies --workspace="$MAIN_PKG"
