/**
 * Daemon side of the Node watchdog on Windows. The Go launcher put the daemon in a Job Object, so a dead launcher took the
 * daemon with it. The watchdog passes its pid in ORCH_WATCHDOG_PID, and the daemon polls it: once the watchdog is gone the
 * daemon stops through its normal stop path and exits 0. An exit 0 without `config.restart` is a stop nobody restarts, which is
 * the intended outcome. Without the variable (Go launcher, manual run) nothing happens.
 *
 * Observed on Windows 10 (probe, 2026-11-22): libuv already puts a child that is not detached in a kill-on-close job, so a
 * killed watchdog takes its daemon down at once, forcibly. This watch is the graceful path for a daemon that outlives the
 * watchdog anyway (a detached one, a job that could not be assigned).
 */

export const WATCHDOG_PID_ENV = 'ORCH_WATCHDOG_PID';
export const WATCHDOG_POLL_MS = 5_000;
/** After a graceful stop that has not ended the process by then, the daemon exits anyway. */
export const WATCHDOG_STOP_GRACE_MS = 10_000;

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** True when a process with this pid exists. EPERM means it exists but is not ours to signal. */
export function pidIsAlive(pid: number, kill: (pid: number, signal: 0) => void = (p, s) => { process.kill(p, s); }): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
    if (code === 'ESRCH') {
      return false;
    }
    if (code === 'EPERM') {
      return true;
    }
    // Unknown failure: keep the daemon up rather than stopping it on a guess; the caller logs it.
    throw e;
  }
}

export interface WatchdogWatchOptions {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Called once, when the watchdog is gone. */
  onGone: () => void;
  isAlive?: (pid: number) => boolean;
  intervalMs?: number;
  setInterval?: (fn: () => void, ms: number) => { unref(): unknown };
  clearInterval?: (timer: unknown) => void;
}

/**
 * Starts watching the pid in ORCH_WATCHDOG_PID. Returns null when the variable is absent (nothing to do) or unusable (said in
 * the log, with what it means: this daemon will not follow the watchdog). The timer is unref'd: it never keeps the daemon alive.
 */
export function startWatchdogWatch(opts: WatchdogWatchOptions): { stop(): void } | null {
  const raw = opts.env[WATCHDOG_PID_ENV];
  if (raw === undefined || raw === '') {
    return null;
  }
  const pid = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    opts.log(`${WATCHDOG_PID_ENV}="${raw}" is not a pid: the daemon will NOT stop when its watchdog dies. Unset it, or restart with: orch stop, then orch start`);
    return null;
  }
  const isAlive = opts.isAlive ?? ((p: number) => pidIsAlive(p));
  const schedule = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const cancel = opts.clearInterval ?? ((t) => { clearInterval(t as NodeJS.Timeout); });
  let reportedProbeError = false;
  let done = false;

  const timer = schedule(() => {
    if (done) {
      return;
    }
    let alive: boolean;
    try {
      alive = isAlive(pid);
    } catch (e) {
      if (!reportedProbeError) {
        reportedProbeError = true;
        opts.log(`could not check the watchdog (pid ${pid}): ${errText(e)}; the daemon keeps running and checks again`);
      }
      return;
    }
    if (alive) {
      return;
    }
    done = true;
    cancel(timer);
    opts.log(`the watchdog (pid ${pid}) is gone: stopping the daemon`);
    opts.onGone();
  }, opts.intervalMs ?? WATCHDOG_POLL_MS);
  timer.unref();
  opts.log(`watching the watchdog (pid ${pid}): the daemon stops when it is gone`);
  return { stop: () => { done = true; cancel(timer); } };
}

export interface GoneHandlerOptions {
  /** The daemon's normal stop (the one SIGTERM and /quit go through): supervised jobs are left running, as on any stop. */
  stop: () => Promise<void>;
  exit: (code: number) => void;
  log: (line: string) => void;
  graceMs?: number;
  setTimeout?: (fn: () => void, ms: number) => { unref(): unknown };
}

/**
 * The onGone handler: stops the daemon gracefully and exits 0. A stop that fails exits 1; a stop that does not end the process
 * within the grace period exits 0 anyway, because a daemon left running without a watchdog is the very case being avoided.
 */
export function stopWhenWatchdogGone(opts: GoneHandlerOptions): () => void {
  const schedule = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  return () => {
    // Unref'd: it fires only when something else is keeping the process alive.
    schedule(() => {
      opts.log(`the daemon did not end ${(opts.graceMs ?? WATCHDOG_STOP_GRACE_MS) / 1000}s after its stop: exiting now`);
      opts.exit(0);
    }, opts.graceMs ?? WATCHDOG_STOP_GRACE_MS).unref();
    opts.stop().then(
      () => { opts.log('daemon stopped after the loss of its watchdog; no restart is requested'); },
      (e: unknown) => {
        opts.log(`stop after the loss of the watchdog failed: ${errText(e)}; exiting with 1. Start again with: orch start`);
        opts.exit(1);
      },
    );
  };
}
