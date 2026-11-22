/**
 * The supervision loop of the Node watchdog: port of superviseDaemon, checkSentinels and writeCrashMarker of the Go launcher
 * (singleton-daemon-kit/go-launcher: crashrestart.go, launcher.go). Every effect is injected, as in the Go seam: the tests
 * start no process and wait for no delay.
 *
 * `config.update` (the Go launcher's second sentinel) is deliberately not ported: nothing in orchestrator writes it.
 */
import path from 'node:path';

import { describeDuration, describeExit, describeWindow, recordCrash, type CrashPolicy } from './policy.js';

export const RESTART_SENTINEL = 'config.restart';
export const CRASH_MARKER_FILE = 'crashed.json';
/** The "source" of a marker written here. Same value as the Go launcher's: a marker with another source is the daemon's own. */
export const MARKER_SOURCE = 'launcher';

export interface WatchdogFs {
  /** False when the file is absent; any other failure throws. */
  exists(file: string): boolean;
  readText(file: string): string;
  /** Creates the file, failing with code EEXIST when it exists (O_EXCL). */
  writeExclusive(file: string, body: string): void;
  writeFile(file: string, body: string): void;
  rename(from: string, to: string): void;
  remove(file: string): void;
}

export interface WatchdogLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** One running daemon. */
export interface DaemonHandle {
  pid: number;
  /** Settles when the daemon is gone. code is -1 for a process that did not exit by itself (killed by a signal). */
  exited: Promise<{ code: number }>;
  /** True when the watchdog had been asked to stop (a signal it received, forwarded or not) before the daemon ended. */
  wasSignalled(): boolean;
}

export interface WatchdogDeps {
  fs: WatchdogFs;
  log: WatchdogLog;
  /** Milliseconds since the epoch. */
  now(): number;
  /** Waits; resolves true as soon as the watchdog is asked to stop, false when the delay elapsed. */
  sleep(ms: number): Promise<boolean>;
  /** The bundle to run, looked up at every start so an update's new bundle is picked up. Throws with an actionable message. */
  resolveBundle(): string;
  /** Starts the daemon on that bundle. Rejects when the process cannot be started. */
  startDaemon(bundle: string): Promise<DaemonHandle>;
  /** Writes / removes config.launcher-pid. */
  pidFile: { write(): void; remove(): void };
  /** The node that runs the daemon and the watchdog's own pid, for the log. */
  nodePath: string;
  pid: number;
}

export interface WatchdogConfig {
  configDir: string;
  policy: CrashPolicy;
  /** What the log tells the user to run once the watchdog has given up. */
  startCommand: string;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const codeOf = (e: unknown): string | undefined => (e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined);

/**
 * Runs the daemon until it ends for good and returns the code the watchdog exits with.
 *
 *  - exit 0: `config.restart` present means start again (the sentinel is removed), absent means the end;
 *  - a failure nobody asked for: marker, back-off, restart, at most policy.maxRestarts in the window, then the end with the
 *    daemon's last code;
 *  - a failure after a stop signal: the end, with the daemon's code;
 *  - a node, a bundle or a spawn problem restarting cannot fix: the end with 1.
 */
export async function superviseDaemon(cfg: WatchdogConfig, deps: WatchdogDeps): Promise<number> {
  const { log, fs } = deps;
  let crashes: number[] = [];
  try {
    for (;;) {
      const runStart = deps.now();

      let bundle: string;
      try {
        bundle = deps.resolveBundle();
      } catch (e) {
        log.error(errText(e));
        return 1;
      }
      log.info(`configDir=${cfg.configDir}`);
      log.info(`spawning ${deps.nodePath} ${bundle} ${cfg.configDir}`);
      let handle: DaemonHandle;
      try {
        handle = await deps.startDaemon(bundle);
      } catch (e) {
        log.error(`could not start the daemon (${deps.nodePath} ${bundle}): ${errText(e)}. Check that node is installed and runnable, `
          + `and that the bundle is not damaged; reinstall with: npm install -g @wadeck-app/orchestrator-cli`);
        return 1;
      }
      try {
        deps.pidFile.write();
      } catch (e) {
        log.warn(`could not write launcher PID file: ${errText(e)}`);
      }
      log.info(`PIDs: launcher=${deps.pid} node=${handle.pid}`);

      const { code } = await handle.exited;
      const signalled = handle.wasSignalled();
      log.info(code === 0 ? 'node exited cleanly' : `node exited with code ${code}`);
      log.info(`post-exit check: exitCode=${code}`);

      if (code === 0) {
        if (checkRestartSentinel(cfg.configDir, fs, log)) {
          if (!signalled) {
            continue;
          }
          // A restart was in flight when the stop came: the stop wins, the sentinel is consumed so it cannot restart a later run.
          log.warn('stop signal received together with a restart request: not restarting');
        }
        return 0;
      }

      if (signalled) {
        return code;
      }

      const verdict = recordCrash(crashes, deps.now(), cfg.policy);
      crashes = verdict.crashes;
      const window = describeWindow(cfg.policy.windowMs);
      log.error(`daemon crashed: ${describeExit(code)} (crash ${verdict.count} in the last ${window})`);
      writeCrashMarker(cfg.configDir, { code, pid: handle.pid }, runStart, deps.now(), fs, (m) => log.warn(m));

      if (verdict.giveUp) {
        log.error(`daemon crashed ${verdict.count} times in ${window}, not restarting: see ${path.join(cfg.configDir, 'logs')}, then run ${cfg.startCommand}`);
        return code;
      }
      log.warn(`restarting in ${describeDuration(verdict.delayMs)} (crash ${verdict.count} of ${cfg.policy.maxRestarts} allowed in ${window})`);
      if (await deps.sleep(verdict.delayMs)) {
        log.warn(`stop signal received while waiting to restart: not restarting, exiting with the daemon's last code ${code}`);
        return code;
      }
    }
  } finally {
    try {
      deps.pidFile.remove();
    } catch (e) {
      log.warn(`could not remove the launcher PID file: ${errText(e)}`);
    }
  }
}

/** True when the daemon asked for a restart: the sentinel is consumed. A sentinel that cannot be read or removed is not a restart. */
function checkRestartSentinel(configDir: string, fs: WatchdogFs, log: WatchdogLog): boolean {
  const sentinel = path.join(configDir, RESTART_SENTINEL);
  let present: boolean;
  try {
    present = fs.exists(sentinel);
  } catch (e) {
    log.warn(`Could not read restart sentinel (${sentinel}): ${errText(e)}`);
    return false;
  }
  if (!present) {
    log.info('Exiting cleanly — no restart requested.');
    return false;
  }
  log.info('restart sentinel detected — relaunching');
  try {
    fs.remove(sentinel);
  } catch (e) {
    log.warn(`restart sentinel found but could not remove (${errText(e)}) — not relaunching: delete ${sentinel} by hand, then run orch start`);
    return false;
  }
  return true;
}

/**
 * Leaves <configDir>/crashed.json for the status command. Never fails the watchdog: a marker that cannot be written is a warning.
 *
 * Which report wins (same rules as the Go launcher):
 *  - no file: this one is written, exclusively, so a daemon writing at the same instant is not overwritten;
 *  - a file this watchdog (or the Go launcher) wrote, dated before runStart: it reports an earlier crash nobody cleared, so it
 *    is replaced by this one;
 *  - anything else is kept: the daemon's own report (it says why), a launcher report not older than the run, a file that is
 *    not valid JSON (warned, with the file to delete).
 */
export function writeCrashMarker(
  configDir: string, res: { code: number; pid: number }, runStart: number, now: number, fs: WatchdogFs, warn: (message: string) => void,
): void {
  const file = path.join(configDir, CRASH_MARKER_FILE);
  const body = JSON.stringify({
    time: new Date(now).toISOString(),
    kind: 'exit',
    source: MARKER_SOURCE,
    error: `${describeExit(res.code)} and left no crash report of its own`,
    version: 'unknown',
    pid: res.pid,
  }, null, 2);

  try {
    fs.writeExclusive(file, body);
    return;
  } catch (e) {
    if (codeOf(e) !== 'EEXIST') {
      warn(`could not write the crash marker ${file}: ${errText(e)} (status commands will not report this crash)`);
      return;
    }
  }

  let existing: string;
  try {
    existing = fs.readText(file);
  } catch (e) {
    warn(`could not read the existing crash marker ${file}: ${errText(e)} (status commands may report an older crash)`);
    return;
  }
  let prev: { time?: unknown; source?: unknown };
  try {
    const parsed: unknown = JSON.parse(existing);
    prev = typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch (e) {
    warn(`the existing crash marker ${file} is not valid JSON (${errText(e)}), so the watchdog left it: delete it to get this crash reported`);
    return;
  }
  if (prev.source !== MARKER_SOURCE) {
    return;
  }
  const prevTime = typeof prev.time === 'string' ? Date.parse(prev.time) : Number.NaN;
  // An unparseable time on our own file is treated as stale; a time not before the run is not about an earlier run.
  if (!Number.isNaN(prevTime) && !(prevTime < runStart)) {
    return;
  }
  // Written beside the marker, then renamed over it: a status command never reads half a file.
  const tmp = `${file}.tmp`;
  try {
    fs.writeFile(tmp, body);
  } catch (e) {
    warn(`could not write the crash marker ${tmp}: ${errText(e)} (status commands will keep reporting the previous crash)`);
    return;
  }
  try {
    fs.rename(tmp, file);
  } catch (e) {
    try { fs.remove(tmp); } catch { /* the rename failure below is the one worth reporting */ }
    warn(`could not replace the crash marker ${file}: ${errText(e)} (status commands will keep reporting the previous crash)`);
  }
}
