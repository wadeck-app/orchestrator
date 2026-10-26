// Single source of truth for locating this install's native binaries and daemon bundle.
//
// Three call sites used to resolve these independently (startup.ts, tray-manager.ts,
// cli.ts) and cli.ts did it with hardcoded relative paths, which silently stopped
// resolving as soon as npm nested the platform package under the main package instead
// of hoisting it next to it. Everything here goes through require.resolve, which walks
// the node_modules chain the way Node does and is therefore layout-independent.
import path from 'node:path';
import fs   from 'node:fs';
import { getErrorMessage } from './fsUtil.js';

/**
 * The one table of the platforms we ship for. Everything that lists platforms (the platform package scripts in
 * ci/scripts, optionalDependencies, scripts/build-supervisor-binary.ts) is checked against it by
 * test/platform-targets.test.js, so a platform cannot be added here and forgotten there.
 *
 * *Dev names are the files a source checkout builds (launcher-go/dist, tray-go/dist, supervisor-go/dist); inside a
 * platform package the files are named plainly. `trayDev` is null where there is no systray build (Linux).
 */
export interface PlatformTarget {
  pkg:           string;
  launcherDev:   string;
  trayDev:       string | null;
  supervisorDev: string;
}

export const PLATFORM_TARGETS: Readonly<Record<string, PlatformTarget>> = {
  'win32-x64': {
    pkg: '@wadeck-app/orchestrator-cli-win32-x64',
    launcherDev: 'orchestrator_windows_release.exe', trayDev: 'orchestrator-tray.exe', supervisorDev: 'orchestrator-supervisor.exe',
  },
  'darwin-arm64': {
    pkg: '@wadeck-app/orchestrator-cli-darwin-arm64',
    launcherDev: 'orchestrator_darwin_arm64_release', trayDev: 'orchestrator-tray-arm64', supervisorDev: 'orchestrator-supervisor-arm64',
  },
  'darwin-x64': {
    pkg: '@wadeck-app/orchestrator-cli-darwin-x64',
    launcherDev: 'orchestrator_darwin_amd64_release', trayDev: 'orchestrator-tray-amd64', supervisorDev: 'orchestrator-supervisor-amd64',
  },
  'linux-arm64': {
    pkg: '@wadeck-app/orchestrator-cli-linux-arm64',
    launcherDev: 'orchestrator_linux_arm64_release', trayDev: null, supervisorDev: 'orchestrator-supervisor-linux-arm64',
  },
  'linux-x64': {
    pkg: '@wadeck-app/orchestrator-cli-linux-x64',
    launcherDev: 'orchestrator_linux_amd64_release', trayDev: null, supervisorDev: 'orchestrator-supervisor-linux-amd64',
  },
};

/** The key of a platform and architecture: every architecture that is not arm64 counts as x64, as the package names do. */
export function platformKeyOf(platform: string, arch: string): string {
  return `${platform}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/** True where a systray binary is built (Windows, macOS). Linux has none: its daemon is reached with `orch server start`. */
export function platformHasTray(platform: string): boolean {
  return Object.entries(PLATFORM_TARGETS).some(([key, t]) => key.startsWith(`${platform}-`) && t.trayDev !== null);
}

/**
 * What is wrong with the installed native binaries, or null. The tray is required only where one is built. Each name carries
 * the package it should have come from, because npm skips a failed optionalDependency without a word.
 */
export function nativeBinaryProblem(found: { platform: string; pkg: string; launcher: boolean; tray: boolean; supervisor: boolean }): string | null {
  if (!found.launcher) {
    return `Go launcher not found; expected in ${found.pkg}`;
  }
  if (!found.supervisor) {
    return `supervisor not found; expected in ${found.pkg}`;
  }
  if (platformHasTray(found.platform) && !found.tray) {
    return `tray binary not found; expected in ${found.pkg}`;
  }
  return null;
}

/** The daemon-log line when no tray can be started: a broken install where a tray is built, a plain fact where none is. */
export function trayUnavailableMessage(platform: string, arch: string, pkg: string | null): string {
  const supported = Object.keys(PLATFORM_TARGETS).some((key) => key.startsWith(`${platform}-`));
  if (supported && !platformHasTray(platform)) {
    return `[tray] no systray build for ${platform}: the daemon runs without one. Open the dashboard with: orch server start`;
  }
  return `[tray] systray disabled: binary not found. Expected in ${pkg ?? `${platform}-${arch} (unsupported)`}`
    + ', or in tray-go/dist for a monorepo checkout. Re-install with: npm install -g @wadeck-app/orchestrator-cli';
}

/** npm package holding the native binaries for the running platform, or null if unsupported. */
export function platformPackage(): string | null {
  return PLATFORM_TARGETS[platformKey()]?.pkg ?? null;
}

// Inside the platform package the arch is encoded in the package name, so the files are
// named plainly. The dev build in tray-go/dist keeps the arch suffix.
const LAUNCHER_IN_PLATFORM_PKG = process.platform === 'win32' ? 'orchestrator.exe' : 'orchestrator';
const TRAY_IN_PLATFORM_PKG     = process.platform === 'win32' ? 'orchestrator-tray.exe' : 'orchestrator-tray';
const SUPERVISOR_IN_PLATFORM_PKG = process.platform === 'win32' ? 'orchestrator-supervisor.exe' : 'orchestrator-supervisor';

// Keyed on the platform too, not just the arch: a bare arch ternary returned the darwin
// binary on any non-Windows host, so a Linux checkout would find and try to exec a Mach-O
// file. A target absent from PLATFORM_TARGETS resolves to null and the caller reports an
// unsupported platform.
function platformKey(): string {
  return platformKeyOf(process.platform, process.arch);
}

function resolveInPlatformPackage(fileName: string): string | null {
  const pkg = platformPackage();
  if (!pkg) {
    return null;
  }
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
    throw new Error(`Cannot stage the native binary: ${source} is not readable (${getErrorMessage(err)}).`);
  }

  try {
    if (fs.statSync(target).size === sourceSize) {
      return target;
    }
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
      `Cannot stage the native binary to ${target} (${getErrorMessage(err)}).\n\n`
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
    if (!entry.isDirectory() || entry.name === keepStamp) {
      continue;
    }
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true });
      removed++;
    } catch {
      // Still in use; the next start will try again.
    }
  }
  return removed;
}

/** Go launcher binary: the process that supervises the daemon. */
export function findLauncherBinary(): string | null {
  const fromPkg = resolveInPlatformPackage(LAUNCHER_IN_PLATFORM_PKG);
  if (fromPkg) {
    return fromPkg;
  }
  const devName = PLATFORM_TARGETS[platformKey()]?.launcherDev;
  if (!devName) {
    return null;
  }
  return firstExisting([path.join(__dirname, '..', 'launcher-go', 'dist', devName)]);
}

/** Systray binary, spawned by the daemon. */
export function findTrayBinary(): string | null {
  const fromPkg = resolveInPlatformPackage(TRAY_IN_PLATFORM_PKG);
  if (fromPkg) {
    return fromPkg;
  }
  const devName = PLATFORM_TARGETS[platformKey()]?.trayDev;
  if (!devName) {
    return null;
  }
  return firstExisting([path.join(__dirname, '..', 'tray-go', 'dist', devName)]);
}

/** The per-job supervisor, started detached by the daemon for each job. */
export function findSupervisorBinary(): string | null {
  const fromPkg = resolveInPlatformPackage(SUPERVISOR_IN_PLATFORM_PKG);
  if (fromPkg) {
    return fromPkg;
  }
  const devName = PLATFORM_TARGETS[platformKey()]?.supervisorDev;
  if (!devName) {
    return null;
  }
  return firstExisting([path.join(__dirname, '..', 'supervisor-go', 'dist', devName)]);
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
  if (!pkg) {
    return null;
  }
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
  if (resolved === null) {
    return null;
  }
  if (!resolved.includes('node_modules')) {
    return resolved;
  }
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

/**
 * The supervisor to start for a job: staged out of node_modules, because a running executable cannot be replaced
 * on Windows and an update must be able to replace this one while jobs still run under it.
 */
export function supervisorToRun(configDir: string): string | null {
  return toRun(findSupervisorBinary(), configDir);
}

/** Drops staged copies from every version but the one this install would use. */
export function pruneStaleStagedBinaries(configDir: string): number {
  const stamp = platformPackageVersion();
  if (stamp === null) {
    return 0;
  }
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
  if (!hasBundle) {
    return hasTscOut ? tscOut : null;
  }
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
