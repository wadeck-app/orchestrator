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
  return PLATFORM_PKG[platformKey()] ?? null;
}

// Inside the platform package the arch is encoded in the package name, so the files are
// named plainly. The dev build in tray-go/dist keeps the arch suffix.
const LAUNCHER_IN_PLATFORM_PKG = process.platform === 'win32' ? 'orchestrator.exe' : 'orchestrator';
const TRAY_IN_PLATFORM_PKG     = process.platform === 'win32' ? 'orchestrator-tray.exe' : 'orchestrator-tray';

// Keyed on the platform too, not just the arch: a bare arch ternary returned the darwin
// binary on any non-Windows host, so a Linux checkout would find and try to exec a Mach-O
// file. Only the targets build.sh and build-tray-binary.ts actually produce are listed;
// anything else resolves to null and the caller reports an unsupported platform.
const LAUNCHER_DEV_NAME: Record<string, string> = {
  'win32-x64':    'orchestrator_windows_release.exe',
  'darwin-arm64': 'orchestrator_darwin_arm64_release',
  'darwin-x64':   'orchestrator_darwin_amd64_release',
};

const TRAY_DEV_NAME: Record<string, string> = {
  'win32-x64':    'orchestrator-tray.exe',
  'darwin-arm64': 'orchestrator-tray-arm64',
  'darwin-x64':   'orchestrator-tray-amd64',
};

function platformKey(): string {
  return `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

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
  const fromPkg = resolveInPlatformPackage(LAUNCHER_IN_PLATFORM_PKG);
  if (fromPkg) return fromPkg;
  const devName = LAUNCHER_DEV_NAME[platformKey()];
  if (!devName) return null;
  return firstExisting([path.join(__dirname, '..', 'launcher-go', 'dist', devName)]);
}

/** Systray binary, spawned by the daemon. */
export function findTrayBinary(): string | null {
  const fromPkg = resolveInPlatformPackage(TRAY_IN_PLATFORM_PKG);
  if (fromPkg) return fromPkg;
  const devName = TRAY_DEV_NAME[platformKey()];
  if (!devName) return null;
  return firstExisting([path.join(__dirname, '..', 'tray-go', 'dist', devName)]);
}

/**
 * Daemon entry point sitting next to this module: the published bundle, or the tsc output
 * in a dev checkout. Resolved from __dirname rather than from the launcher's location, so
 * it does not care where npm put the platform package.
 */
export function findDaemonEntry(): string | null {
  // Published packages ship only the bundle; a dev checkout can hold both. The bundle always
  // wins, so which code runs never depends on build order or on mtimes that `git checkout`
  // rewrites. Newest-wins was tried and is worse than it looks: it silently swapped the daemon
  // between bundled and tsc output, so the same command ran different code on two machines with
  // no way to tell from the outside.
  const bundle = path.join(__dirname, 'orchestrator.cjs');
  const tscOut = path.join(__dirname, 'index.js');
  const hasBundle = fs.existsSync(bundle);
  const hasTscOut = fs.existsSync(tscOut);
  if (!hasBundle) return hasTscOut ? tscOut : null;
  // A stale bundle is reported instead of being worked around. Silently preferring the fresher
  // tsc output would hide the fact that `npm run bundle` was never run, and silently running the
  // stale bundle would hide it just as well -- so say it, and name the command that fixes it.
  if (hasTscOut && fs.statSync(tscOut).mtimeMs > fs.statSync(bundle).mtimeMs) {
    try {
      process.stderr.write(
        `[orchestrator] warning: ${tscOut} is newer than ${bundle}, so the bundle is stale and `
        + `the daemon below is running pre-build code. Refresh it with: `
        + `npm run bundle --workspace=packages/orchestrator-cli\n`,
      );
    } catch { /* EPIPE: launcher pipe closed */ }
  }
  return bundle;
}
