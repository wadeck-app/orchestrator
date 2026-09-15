// Single source of truth for locating this install's native binaries and daemon bundle.
//
// Three call sites used to resolve these independently (startup.ts, tray-manager.ts,
// cli.ts) and cli.ts did it with hardcoded relative paths, which silently stopped
// resolving as soon as npm nested the platform package under the main package instead
// of hoisting it next to it. Everything here goes through require.resolve, which walks
// the node_modules chain the way Node does and is therefore layout-independent.
import path from 'node:path';
import fs   from 'node:fs';

const PLATFORM_PKG: Record<string, string> = {
  'win32-x64':    '@wadeck-app/orchestrator-cli-win32-x64',
  'darwin-arm64': '@wadeck-app/orchestrator-cli-darwin-arm64',
  'darwin-x64':   '@wadeck-app/orchestrator-cli-darwin-x64',
};

/** npm package holding the native binaries for the running platform, or null if unsupported. */
export function platformPackage(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  return PLATFORM_PKG[`${process.platform}-${arch}`] ?? null;
}

// Inside the platform package the arch is encoded in the package name, so the files are
// named plainly. The dev build in tray-go/dist keeps the arch suffix.
const LAUNCHER_IN_PLATFORM_PKG = process.platform === 'win32' ? 'orchestrator.exe' : 'orchestrator';
const TRAY_IN_PLATFORM_PKG     = process.platform === 'win32' ? 'orchestrator-tray.exe' : 'orchestrator-tray';

const LAUNCHER_DEV_NAME =
  process.platform === 'win32'
    ? 'orchestrator_windows_release.exe'
    : process.arch === 'arm64'
      ? 'orchestrator_darwin_arm64_release'
      : 'orchestrator_darwin_amd64_release';

const TRAY_DEV_NAME =
  process.platform === 'win32'
    ? 'orchestrator-tray.exe'
    : process.arch === 'arm64'
      ? 'orchestrator-tray-arm64'
      : 'orchestrator-tray-amd64';

function resolveInPlatformPackage(fileName: string): string | null {
  const pkg = platformPackage();
  if (!pkg) return null;
  try {
    return require.resolve(`${pkg}/${fileName}`);
  } catch {
    // Platform package absent (dev checkout, or optionalDependencies skipped).
    return null;
  }
}

function firstExisting(candidates: string[]): string | null {
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Go launcher binary: the process that supervises the daemon. */
export function findLauncherBinary(): string | null {
  return resolveInPlatformPackage(LAUNCHER_IN_PLATFORM_PKG)
    ?? firstExisting([path.join(__dirname, '..', 'launcher-go', 'dist', LAUNCHER_DEV_NAME)]);
}

/** Systray binary, spawned by the daemon. */
export function findTrayBinary(): string | null {
  return resolveInPlatformPackage(TRAY_IN_PLATFORM_PKG)
    ?? firstExisting([path.join(__dirname, '..', 'tray-go', 'dist', TRAY_DEV_NAME)]);
}

/**
 * Daemon entry point sitting next to this module: the published bundle, or the tsc output
 * in a dev checkout. Resolved from __dirname rather than from the launcher's location, so
 * it does not care where npm put the platform package.
 */
export function findDaemonEntry(): string | null {
  return firstExisting([
    path.join(__dirname, 'orchestrator.cjs'),
    path.join(__dirname, 'index.js'),
  ]);
}
