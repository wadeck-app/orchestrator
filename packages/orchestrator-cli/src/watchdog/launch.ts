/**
 * `orch start --watchdog` / ORCH_WATCHDOG=1 (EXPERIMENTAL): what the CLI spawns instead of the Go launcher. Pure, so a test can
 * hold it to account without starting anything.
 */
import { WATCHDOG_PID_ENV } from './pid-watch.js';

export const WATCHDOG_ENV = 'ORCH_WATCHDOG';
export const WATCHDOG_FLAG = '--watchdog';

/** Opt-in by the flag or ORCH_WATCHDOG=1. Any other non-empty value than 0/1 throws: a typo must not pick a launcher in silence. */
export function wantsWatchdog(flag: boolean, env: NodeJS.ProcessEnv): boolean {
  const value = env[WATCHDOG_ENV];
  if (value !== undefined && value !== '' && value !== '0' && value !== '1') {
    throw new Error(`${WATCHDOG_ENV}="${value}" is not valid: use ${WATCHDOG_ENV}=1 to start the Node watchdog (experimental), or unset it / set 0 for the Go launcher`);
  }
  return flag || value === '1';
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
