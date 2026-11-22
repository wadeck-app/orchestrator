/**
 * Crash policy of the Node watchdog: port of the Go launcher's CrashRestart (singleton-daemon-kit/go-launcher/crashrestart.go).
 * Pure: no clock, no file, no process.
 */

export interface CrashPolicy {
  /** delaysMs[n] is the wait before the n+1th restart within the window; the last one is reused. */
  delaysMs: readonly number[];
  /** Crash restarts allowed in any window; the next crash is not restarted. */
  maxRestarts: number;
  windowMs: number;
}

export const DEFAULT_CRASH_POLICY: CrashPolicy = {
  delaysMs: [2_000, 10_000, 30_000],
  maxRestarts: 3,
  windowMs: 10 * 60_000,
};

/** Test-only: comma list of delays in ms, replaces the 2s,10s,30s back-off. */
export const DELAYS_ENV = 'ORCH_WATCHDOG_DELAYS_MS';
/** Test-only: the rolling window in ms, replaces the 10 minutes. */
export const WINDOW_ENV = 'ORCH_WATCHDOG_WINDOW_MS';

function parseMs(name: string, raw: string, what: string): number {
  const text = raw.trim();
  // Number('') is 0 and Number('1e3') is 1000: only plain digits are a duration here.
  if (!/^\d+$/.test(text)) {
    throw new Error(`${name}="${raw}" is not valid: ${what}. Unset ${name} to use the default policy (test-only variable).`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name}="${raw}" is not valid: ${what}. Unset ${name} to use the default policy (test-only variable).`);
  }
  return value;
}

/** The policy, defaults unless the test-only variables are set. A malformed value throws: it is never ignored. */
export function policyFromEnv(env: NodeJS.ProcessEnv): CrashPolicy {
  let delaysMs = DEFAULT_CRASH_POLICY.delaysMs;
  let windowMs = DEFAULT_CRASH_POLICY.windowMs;
  const delays = env[DELAYS_ENV];
  if (delays !== undefined && delays !== '') {
    delaysMs = delays.split(',').map((part) => parseMs(DELAYS_ENV, part, `expected a comma list of positive integers (milliseconds), e.g. 20,50,100; "${part}" is not one`));
  }
  const window = env[WINDOW_ENV];
  if (window !== undefined && window !== '') {
    windowMs = parseMs(WINDOW_ENV, window, 'expected a positive integer (milliseconds)');
  }
  return { ...DEFAULT_CRASH_POLICY, delaysMs, windowMs };
}

export interface CrashVerdict {
  /** Crash times still inside the window, this one included. Pass it back at the next crash. */
  crashes: number[];
  /** Crashes in the window, this one included. */
  count: number;
  /** The count exceeds maxRestarts: do not restart. */
  giveUp: boolean;
  /** Wait before the restart; meaningful only when giveUp is false. */
  delayMs: number;
}

/** Records a crash at `now`: forgets the ones older than the window, counts, and says whether and when to restart. */
export function recordCrash(previous: readonly number[], now: number, policy: CrashPolicy): CrashVerdict {
  const crashes = previous.filter((t) => now - t < policy.windowMs);
  crashes.push(now);
  const count = crashes.length;
  const delayMs = policy.delaysMs[Math.min(count - 1, policy.delaysMs.length - 1)] ?? 0;
  return { crashes, count, giveUp: count > policy.maxRestarts, delayMs };
}

/**
 * What an exit code means, for the log and the marker. -1 stands for a daemon that did not exit by itself (POSIX death by a
 * signal: SIGKILL, the OOM killer's). On Windows a forced kill (taskkill /F) shows as 1.
 */
export function describeExit(code: number): string {
  if (code < 0) {
    return `node exited with code ${code} (killed by a signal or forcibly terminated, e.g. SIGKILL or the OOM killer)`;
  }
  return `node exited with code ${code}`;
}

/** "10 minutes", "1 minute", or "<n>ms" below a minute (a test-only window). */
export function describeWindow(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) {
    return ms === 60_000 ? '1 minute' : `${ms / 60_000} minutes`;
  }
  return describeDuration(ms);
}

/** "2s", "30s", "50ms". */
export function describeDuration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
}
