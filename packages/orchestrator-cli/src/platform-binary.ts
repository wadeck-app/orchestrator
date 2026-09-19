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

/**
 * Where a native binary is run from: `<configDir>/bin/<stamp>/<name>`.
 *
 * Deliberately outside node_modules. npm installs the platform package in there, and updating the
 * main package means moving that directory aside -- `fs.rename` first, then, when Windows refuses
 * because a descendant is a running image (EPERM), @npmcli/fs falls back to copying file by file, and
 * copying a running .exe is EBUSY. Nothing here holds a file npm has to move.
 */
export function stagedBinaryPath(configDir: string, stamp: string, fileName: string): string {
  return path.join(configDir, 'bin', stamp, fileName);
}

/**
 * Copies a native binary out of node_modules, once per stamp, and returns the path to run.
 *
 * Throws rather than falling back to the source path: a silent fallback would put the EBUSY back
 * without a word, which is the failure this exists to remove.
 *
 * A short copy is replaced, since an interrupted one would fail at exec time pointing nowhere near
 * the cause. Sizes are compared rather than hashed -- hashing two multi-megabyte binaries on every
 * daemon start is not worth catching a same-size corruption, which no observed failure produces.
 */
export function stageBinary(source: string, configDir: string, stamp: string): string {
  const fileName = path.basename(source);
  const target   = stagedBinaryPath(configDir, stamp, fileName);

  let sourceSize: number;
  try {
    sourceSize = fs.statSync(source).size;
  } catch (err) {
    throw new Error(`Cannot stage the native binary: ${source} is not readable (${describe(err)}).`);
  }

  try {
    if (fs.statSync(target).size === sourceSize) return target;
  } catch {
    // Not staged yet, which is the normal path on a new version.
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Written beside the target then renamed, so a copy interrupted by a crash or a power loss cannot
    // leave a short file at the path the launcher is started from.
    const partial = `${target}.partial`;
    fs.copyFileSync(source, partial);
    fs.renameSync(partial, target);
  } catch (err) {
    throw new Error(
      `Cannot stage the native binary to ${target} (${describe(err)}).\n\n`
      + `It is copied out of node_modules on purpose: npm cannot update a package while one of its `
      + `binaries is running, so orch must not execute this file from where npm installed it `
      + `(${source}).`,
    );
  }
  return target;
}

/**
 * Deletes staged binaries from versions other than `keepStamp`, and returns how many went.
 *
 * Failures are skipped, not raised: an older launcher may still be running from its own copy, and
 * Windows refuses to delete a running image. That is expected at every daemon start.
 */
export function pruneStagedBinaries(configDir: string, keepStamp: string): number {
  const root = path.join(configDir, 'bin');
  let removed = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepStamp) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true });
      removed++;
    } catch {
      // Still in use; the next start will try again.
    }
  }
  return removed;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * Version of the installed platform package, used as the staging stamp.
 *
 * Not the main package's version: that changes several times a day, which would recopy the binaries
 * and rewrite the start-at-login path for nothing. The platform package is republished only when a
 * binary hash changes, so the stamp changes exactly when the copy must be refreshed.
 */
function platformPackageVersion(): string | null {
  const pkg = platformPackage();
  if (!pkg) return null;
  try {
    const manifest = require.resolve(`${pkg}/package.json`);
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Stages a resolved binary when it came from the platform package, and returns what to execute.
 *
 * A dev build is returned untouched: nothing npm-managed is at stake in a checkout, and freezing a
 * copy of a binary that is rebuilt by hand would silently run yesterday's launcher.
 */
function toRun(resolved: string | null, configDir: string): string | null {
  if (resolved === null) return null;
  if (!resolved.includes('node_modules')) return resolved;
  const stamp = platformPackageVersion();
  if (stamp === null) {
    throw new Error(
      `Found the native binary at ${resolved} but could not read the version of `
      + `${platformPackage()}, which is needed to copy it out of node_modules. `
      + `Reinstall with: npm install -g @wadeck-app/orchestrator-cli`,
    );
  }
  return stageBinary(resolved, configDir, stamp);
}

/** The launcher to execute or to register at login: staged out of node_modules. */
export function launcherToRun(configDir: string): string | null {
  return toRun(findLauncherBinary(), configDir);
}

/** The tray binary to spawn: staged out of node_modules. */
export function trayToRun(configDir: string): string | null {
  return toRun(findTrayBinary(), configDir);
}

/** Drops staged copies from every version but the one this install would use. */
export function pruneStaleStagedBinaries(configDir: string): number {
  const stamp = platformPackageVersion();
  if (stamp === null) return 0;
  return pruneStagedBinaries(configDir, stamp);
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
