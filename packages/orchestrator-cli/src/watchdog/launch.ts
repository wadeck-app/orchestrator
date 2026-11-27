/**
 * `orch start`: what the CLI spawns, the Node watchdog. The Go launcher was removed (phase C of the watchdog migration): asking
 * for it (`--launcher`, ORCH_LAUNCHER) is an error that says so. Pure, so a test can hold it to account without starting anything.
 */
import { WATCHDOG_PID_ENV } from './pid-watch.js';

export const LAUNCHER_ENV = 'ORCH_LAUNCHER';
export const LAUNCHER_FLAG = '--launcher';
/** Deprecated since the watchdog is the default: still read so it can be reported, never acted on. */
export const WATCHDOG_ENV = 'ORCH_WATCHDOG';
export const WATCHDOG_FLAG = '--watchdog';

/** Whether the arguments ask for the removed launcher: `--launcher` and `--launcher=<value>` (ignoring the second would be silent). */
export function hasLauncherFlag(args: readonly string[]): boolean {
  return args.some((a) => a === LAUNCHER_FLAG || a.startsWith(`${LAUNCHER_FLAG}=`));
}

/** What to tell someone who asks for the removed Go launcher: use the watchdog, or install an older version. */
export function launcherRemovedMessage(what: string): string {
  return `${what} asks for the Go launcher, which was removed: orch start runs the Node watchdog. Drop ${what}. `
    + 'To get the Go launcher back, install an older version: npm install -g @wadeck-app/orchestrator-cli@<version>';
}

export interface StartMode {
  /** One line each for stderr: deprecated spellings that were ignored. */
  notes: string[];
}

/**
 * The start choice of `orch start`: always the watchdog. `--launcher` and a non-empty ORCH_LAUNCHER throw (the Go launcher was
 * removed), whatever the value: a typo and `go` get the same actionable error. `--watchdog` and ORCH_WATCHDOG (the opt-in of
 * the first release) are ignored with a note. Never guesses.
 */
export function resolveStartMode(opts: { launcherFlag: boolean; watchdogFlag: boolean; env: NodeJS.ProcessEnv }): StartMode {
  if (opts.launcherFlag) {
    throw new Error(launcherRemovedMessage(LAUNCHER_FLAG));
  }
  const launcherValue = opts.env[LAUNCHER_ENV];
  if (launcherValue !== undefined && launcherValue !== '') {
    throw new Error(launcherRemovedMessage(`${LAUNCHER_ENV}=${launcherValue}`));
  }
  const legacyValue = opts.env[WATCHDOG_ENV];
  const notes: string[] = [];
  if (opts.watchdogFlag) {
    notes.push(`${WATCHDOG_FLAG} is deprecated and ignored: the Node watchdog is the only way to start the daemon. Drop it.`);
  }
  if (legacyValue !== undefined && legacyValue !== '') {
    notes.push(`${WATCHDOG_ENV} is deprecated and ignored: the Node watchdog is the only way to start the daemon. Unset it.`);
  }
  return { notes };
}

export interface WatchdogSpawnSpec {
  command: string;
  args: string[];
  options: { stdio: 'ignore'; detached: true; windowsHide: true; env: NodeJS.ProcessEnv };
}

/**
 * Detached (a Node child of an MSYS2 shell otherwise holds the shell), hidden,
 * no stdio, the config dir in ORCH_CONFIG_DIR. An inherited LAUNCHER_BUNDLE_OVERRIDE is stripped (the watchdog finds the bundle
 * next to itself), and so is an inherited ORCH_WATCHDOG_PID (it names another watchdog; the watchdog sets its own).
 */
export function watchdogSpawnSpec(opts: { execPath: string; watchdogPath: string; configDir: string; env: NodeJS.ProcessEnv }): WatchdogSpawnSpec {
  const { LAUNCHER_BUNDLE_OVERRIDE: _bundle, [WATCHDOG_PID_ENV]: _pid, ...inherited } = opts.env;
  return {
    command: opts.execPath,
    args: [opts.watchdogPath, opts.configDir],
    options: { stdio: 'ignore', detached: true, windowsHide: true, env: { ...inherited, ORCH_CONFIG_DIR: opts.configDir } },
  };
}
