/**
 * `orch start`: what the CLI spawns, the Node watchdog (default) or the Go launcher (explicit fallback `--launcher` /
 * ORCH_LAUNCHER=go, kept for one release). Pure, so a test can hold it to account without starting anything.
 */
import { WATCHDOG_PID_ENV } from './pid-watch.js';

export const LAUNCHER_ENV = 'ORCH_LAUNCHER';
export const LAUNCHER_FLAG = '--launcher';
/** Deprecated since the watchdog is the default: still read so it can be reported, never acted on. */
export const WATCHDOG_ENV = 'ORCH_WATCHDOG';
export const WATCHDOG_FLAG = '--watchdog';

/**
 * Whether ORCH_LAUNCHER asks for the Go launcher. `go` does; unset or empty does not. Any other value throws: a typo must not pick
 * a launcher in silence.
 */
export function launcherFromEnv(env: NodeJS.ProcessEnv): boolean {
  const value = env[LAUNCHER_ENV];
  if (value === undefined || value === '') {
    return false;
  }
  if (value === 'go') {
    return true;
  }
  throw new Error(`${LAUNCHER_ENV}="${value}" is not valid: set ${LAUNCHER_ENV}=go to use the Go launcher, or unset it for the Node watchdog (default)`);
}

export interface StartMode {
  /** true: the Go launcher (explicit fallback). false: the Node watchdog. */
  launcher: boolean;
  /** One line each for stderr: deprecated spellings that were ignored. */
  notes: string[];
}

/**
 * The launcher choice of `orch start`. The watchdog is the default. `--launcher` or ORCH_LAUNCHER=go picks the Go launcher.
 * `--watchdog` and ORCH_WATCHDOG (the opt-in of the first release) are ignored with a note; asking for both a watchdog (those
 * two, with 1) and the launcher is a contradiction and throws. Never guesses.
 */
export function resolveStartMode(opts: { launcherFlag: boolean; watchdogFlag: boolean; env: NodeJS.ProcessEnv }): StartMode {
  const launcher = opts.launcherFlag || launcherFromEnv(opts.env);
  const legacyValue = opts.env[WATCHDOG_ENV];
  const legacyEnvSet = legacyValue !== undefined && legacyValue !== '';
  const asksWatchdog = opts.watchdogFlag || legacyValue === '1';
  if (launcher && asksWatchdog) {
    throw new Error(
      `${opts.watchdogFlag ? WATCHDOG_FLAG : `${WATCHDOG_ENV}=1`} and ${opts.launcherFlag ? LAUNCHER_FLAG : `${LAUNCHER_ENV}=go`} contradict each other: `
      + `the Node watchdog is the default, so drop ${opts.watchdogFlag ? WATCHDOG_FLAG : `${WATCHDOG_ENV}=1`} (or ${opts.launcherFlag ? LAUNCHER_FLAG : `${LAUNCHER_ENV}=go`} to use the watchdog)`,
    );
  }
  const notes: string[] = [];
  if (opts.watchdogFlag) {
    notes.push(`${WATCHDOG_FLAG} is deprecated and ignored: the Node watchdog is now the default. Use ${LAUNCHER_FLAG} for the Go launcher.`);
  }
  if (legacyEnvSet) {
    notes.push(`${WATCHDOG_ENV} is deprecated and ignored: the Node watchdog is now the default. Unset it, or set ${LAUNCHER_ENV}=go for the Go launcher.`);
  }
  return { launcher, notes };
}

export interface WatchdogSpawnSpec {
  command: string;
  args: string[];
  options: { stdio: 'ignore'; detached: true; windowsHide: true; env: NodeJS.ProcessEnv };
}

/**
 * Same shape as the Go launcher's spawn in cli.ts: detached (a Node child of an MSYS2 shell otherwise holds the shell), hidden,
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
