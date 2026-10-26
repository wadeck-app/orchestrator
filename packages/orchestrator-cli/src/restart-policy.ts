/**
 * The restart policy of a job (`restartOnExit`): bring the job back after ANY exit, with a growing pause between two
 * attempts, and give up on a job that cannot stay up.
 *
 * Pure functions only: the moments are numbers handed in (the scheduler passes its TimeService's clock), so every rule
 * here is testable without a clock and the scheduler holds nothing but the state this module returns.
 *
 * Why this exists next to retryOnExitCodes/retryDelays and not as a change to them: a retry is "this exit code means a
 * transient failure, try again a fixed number of times, then it is permanent"; a restart is "this job must be running,
 * whatever made it stop". The retry list has a ceiling by length and clears its counter only on exit 0, which is wrong for
 * a server that is meant never to exit. The two are mutually exclusive on one job (see restartConflictError).
 */

export const RESTART_STRATEGIES = ['fixed', 'linear', 'exponential'] as const;
export type RestartStrategy = typeof RESTART_STRATEGIES[number];

/**
 * The object form of `restartOnExit`. Every key is optional; `true` is the same as `{}` with every default.
 * Seconds everywhere, to match timeoutSeconds, retryDelays and the other durations of a job.
 */
export interface RestartOnExit {
  /** How the pause grows. Default 'exponential'. fixed: always initialDelaySeconds. linear: + stepSeconds each time. exponential: x factor each time. */
  strategy?: RestartStrategy;
  /** The pause before the first restart, > 0. Default 1. */
  initialDelaySeconds?: number;
  /** exponential only: what the pause is multiplied by at each restart, > 1. Default 2. */
  factor?: number;
  /** linear only: what is added to the pause at each restart, > 0. Default: initialDelaySeconds. */
  stepSeconds?: number;
  /** linear and exponential: the pause never exceeds this, >= initialDelaySeconds. Default 30. */
  maxDelaySeconds?: number;
  /** At most this many restarts within windowSeconds, whole number >= 1. One more and the job is given up on. Default 10. */
  maxRestarts?: number;
  /** The sliding window the limit is counted over, whole seconds >= 1. Default 300 (5 minutes). */
  windowSeconds?: number;
  /** A run that stayed up this long clears the backoff and the window, whole seconds >= 1. Default 900 (15 minutes). */
  stableAfterSeconds?: number;
}

export const RESTART_KEYS = [
  'strategy', 'initialDelaySeconds', 'factor', 'stepSeconds', 'maxDelaySeconds', 'maxRestarts', 'windowSeconds', 'stableAfterSeconds',
] as const;

export const RESTART_DEFAULTS = {
  strategy: 'exponential' as RestartStrategy,
  initialDelaySeconds: 1,
  factor: 2,
  maxDelaySeconds: 30,
  maxRestarts: 10,
  windowSeconds: 300,
  stableAfterSeconds: 900,
};

/** The policy once the defaults are applied. A key the strategy does not use is absent, never a default nobody reads. */
export interface ResolvedRestartPolicy {
  strategy: RestartStrategy;
  initialDelaySeconds: number;
  factor?: number;
  stepSeconds?: number;
  maxDelaySeconds?: number;
  maxRestarts: number;
  windowSeconds: number;
  stableAfterSeconds: number;
}

function show(value: unknown): string {
  return typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isWholeAtLeastOne(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/**
 * Why `value` is not a valid `restartOnExit`, in a sentence that says what to do, or null when it is valid (absent, null
 * and false are valid: the job is simply not restarted). Each message names the key as `restartOnExit.<key>`, which is how
 * the CLI finds the flag to point at.
 */
export function restartOnExitError(value: unknown): string | null {
  if (value === undefined || value === null || value === false || value === true) {
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return `restartOnExit must be true or an object of options (got: ${show(value)}). `
      + 'true restarts the job after any exit with the defaults; clear it with: orch edit <id> --unset restartOnExit';
  }
  const options: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const given = Object.keys(options);
  if (given.length === 0) {
    return 'restartOnExit is empty. Use true for the defaults, or give at least one option '
      + `(${RESTART_KEYS.join(', ')}); to stop restarting the job: orch edit <id> --unset restartOnExit`;
  }
  const unknown = given.find(k => !(RESTART_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) {
    return `restartOnExit has an unknown key "${unknown}". Keys: ${RESTART_KEYS.join(', ')}`;
  }

  const strategy = options['strategy'] ?? RESTART_DEFAULTS.strategy;
  if (!(RESTART_STRATEGIES as readonly unknown[]).includes(strategy)) {
    return `restartOnExit.strategy must be one of ${RESTART_STRATEGIES.join(', ')} (got: ${show(options['strategy'])})`;
  }

  for (const key of ['initialDelaySeconds', 'stepSeconds', 'maxDelaySeconds'] as const) {
    if (options[key] !== undefined && !isPositiveNumber(options[key])) {
      return `restartOnExit.${key} must be a number above 0 (got: ${show(options[key])})`;
    }
  }
  if (options['factor'] !== undefined && !(typeof options['factor'] === 'number' && Number.isFinite(options['factor']) && options['factor'] > 1)) {
    return `restartOnExit.factor must be a number above 1 (got: ${show(options['factor'])}); `
      + 'for a delay that never changes use the fixed strategy';
  }
  for (const key of ['maxRestarts', 'windowSeconds', 'stableAfterSeconds'] as const) {
    if (options[key] !== undefined && !isWholeAtLeastOne(options[key])) {
      return `restartOnExit.${key} must be a whole number of at least 1 (got: ${show(options[key])})`;
    }
  }

  // An option the strategy never reads looks configured and does nothing: refused, like a schedule on a manual job.
  if (options['factor'] !== undefined && strategy !== 'exponential') {
    return `restartOnExit.factor only applies to the exponential strategy, and this job uses "${String(strategy)}". `
      + 'Remove factor, or set strategy to exponential';
  }
  if (options['stepSeconds'] !== undefined && strategy !== 'linear') {
    return `restartOnExit.stepSeconds only applies to the linear strategy, and this job uses "${String(strategy)}". `
      + 'Remove stepSeconds, or set strategy to linear';
  }
  if (options['maxDelaySeconds'] !== undefined && strategy === 'fixed') {
    return 'restartOnExit.maxDelaySeconds does not apply to the fixed strategy (the delay never changes). '
      + 'Remove maxDelaySeconds, or use the linear or exponential strategy';
  }

  if (strategy !== 'fixed') {
    const initial = (options['initialDelaySeconds'] ?? RESTART_DEFAULTS.initialDelaySeconds) as number;
    const explicit = options['maxDelaySeconds'] !== undefined;
    const max = (options['maxDelaySeconds'] ?? RESTART_DEFAULTS.maxDelaySeconds) as number;
    if (initial > max) {
      return `restartOnExit.initialDelaySeconds (${initial}) is above restartOnExit.maxDelaySeconds (${max}${explicit ? '' : ', the default'}). `
        + 'Raise maxDelaySeconds, or use the fixed strategy for a constant delay';
    }
  }
  return null;
}

/** Throws the message of restartOnExitError for a value that is not valid. The caller validated already; this is the guard. */
export function resolveRestartPolicy(value: unknown): ResolvedRestartPolicy | null {
  const problem = restartOnExitError(value);
  if (problem !== null) {
    throw new Error(problem);
  }
  if (value === undefined || value === null || value === false) {
    return null;
  }
  const options = (value === true ? {} : value) as RestartOnExit;
  const strategy = options.strategy ?? RESTART_DEFAULTS.strategy;
  const initialDelaySeconds = options.initialDelaySeconds ?? RESTART_DEFAULTS.initialDelaySeconds;
  return {
    strategy,
    initialDelaySeconds,
    ...(strategy === 'exponential' ? { factor: options.factor ?? RESTART_DEFAULTS.factor } : {}),
    ...(strategy === 'linear' ? { stepSeconds: options.stepSeconds ?? initialDelaySeconds } : {}),
    ...(strategy === 'fixed' ? {} : { maxDelaySeconds: options.maxDelaySeconds ?? RESTART_DEFAULTS.maxDelaySeconds }),
    maxRestarts: options.maxRestarts ?? RESTART_DEFAULTS.maxRestarts,
    windowSeconds: options.windowSeconds ?? RESTART_DEFAULTS.windowSeconds,
    stableAfterSeconds: options.stableAfterSeconds ?? RESTART_DEFAULTS.stableAfterSeconds,
  };
}

/** Why a job cannot have both a restart policy and a retry list; null when it has at most one. */
export function restartConflictError(job: { id?: string; restartOnExit?: unknown; retryOnExitCodes?: unknown; retryDelays?: unknown }): string | null {
  const restarts = job.restartOnExit !== undefined && job.restartOnExit !== null && job.restartOnExit !== false;
  const retries = (Array.isArray(job.retryOnExitCodes) && job.retryOnExitCodes.length > 0)
    || (Array.isArray(job.retryDelays) && job.retryDelays.length > 0);
  if (!restarts || !retries) {
    return null;
  }
  const id = job.id ?? '<id>';
  return 'restartOnExit and retryOnExitCodes/retryDelays cannot be used on the same job: restartOnExit already restarts the job '
    + 'after every exit, so a retry list would never be reached. '
    + `Keep one: orch edit ${id} --unset retryOnExitCodes,retryDelays (to restart after any exit), `
    + `or orch edit ${id} --unset restartOnExit (to retry only some exit codes)`;
}

/** The pause before restart number `attempt` (counted from 1), in seconds. */
export function restartDelaySeconds(policy: ResolvedRestartPolicy, attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`restart attempt must be a whole number of at least 1 (got: ${attempt})`);
  }
  const max = policy.maxDelaySeconds ?? Infinity;
  let delay: number;
  if (policy.strategy === 'fixed') {
    delay = policy.initialDelaySeconds;
  } else if (policy.strategy === 'linear') {
    delay = policy.initialDelaySeconds + (policy.stepSeconds ?? policy.initialDelaySeconds) * (attempt - 1);
  } else {
    // Math.pow overflows to Infinity for a large attempt, which min() brings back to the ceiling.
    delay = policy.initialDelaySeconds * Math.pow(policy.factor ?? RESTART_DEFAULTS.factor, attempt - 1);
  }
  return Math.min(delay, max);
}

/** What the scheduler remembers of a job between two exits. Kept in restart-state.json (see parseRestartStates) so a daemon restart does not give a crash-looping job a fresh budget. */
export interface RestartState {
  /** Restarts since the last stable run: the number the next delay is computed from. */
  attempt: number;
  /** When the restarts still inside the window were scheduled (ms). */
  restarts: number[];
}

export interface RunEnd {
  /** The clock now (ms). */
  nowMs: number;
  startedAtMs: number;
  endedAtMs: number;
  /** The attempt number the run itself carried (it was a restart), used when the daemon holds no state for the job. */
  seedAttempt?: number;
}

export type RestartPlan =
  | { action: 'restart'; attempt: number; delaySeconds: number; restartsInWindow: number; stable: boolean; state: RestartState }
  | { action: 'abandon'; cause: 'limit'; attempts: number; restartsInWindow: number; stable: false; state: RestartState };

/**
 * Decides what follows a run that ended on its own (not a manual kill, which never reaches this function).
 *
 * 1. A run that lasted stableAfterSeconds starts over: no backoff, no restarts counted.
 * 2. The restarts older than the window are forgotten (a sliding window: the last windowSeconds, the oldest edge excluded).
 * 3. If maxRestarts are already inside the window, the answer is 'abandon'.
 * 4. Otherwise 'restart', after the delay of the next attempt.
 */
export function planRestart(policy: ResolvedRestartPolicy, previous: RestartState | undefined, end: RunEnd): RestartPlan {
  const lastedMs = end.endedAtMs - end.startedAtMs;
  const stable = lastedMs >= policy.stableAfterSeconds * 1000;
  const base: RestartState = stable
    ? { attempt: 0, restarts: [] }
    : previous ?? { attempt: end.seedAttempt ?? 0, restarts: [] };
  const windowStart = end.nowMs - policy.windowSeconds * 1000;
  const inWindow = base.restarts.filter(t => t > windowStart);

  if (inWindow.length >= policy.maxRestarts) {
    return {
      action: 'abandon', cause: 'limit', attempts: base.attempt, restartsInWindow: inWindow.length, stable: false,
      state: { attempt: base.attempt, restarts: inWindow },
    };
  }
  const attempt = base.attempt + 1;
  const restarts = [...inWindow, end.nowMs];
  return {
    action: 'restart', attempt, delaySeconds: restartDelaySeconds(policy, attempt),
    restartsInWindow: restarts.length, stable, state: { attempt, restarts },
  };
}

/** The file the counters are kept in, in the config dir. */
export const RESTART_STATE_FILE = 'restart-state.json';

/** What the file holds, as read back: the counters per job, and one sentence per entry (or per file) that could not be used. */
export interface ParsedRestartStates {
  states: Map<string, RestartState>;
  /** What is wrong with an entry; `dropped` when the entry could not be used at all (otherwise it is kept, minus what was ignored). */
  entryProblems: Array<{ jobId: string; problem: string; dropped: boolean }>;
  /** Set when the whole file is unusable (not an object, another version, no `jobs`): the states are then empty. */
  fileProblem: string | null;
}

function isRestartEntry(entry: unknown): entry is { attempt: number; restarts: number[] } {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const attempt  = Reflect.get(entry, 'attempt');
  const restarts = Reflect.get(entry, 'restarts');
  return typeof attempt === 'number' && Number.isInteger(attempt) && attempt >= 0
    && Array.isArray(restarts) && restarts.every(t => typeof t === 'number' && Number.isFinite(t));
}

/**
 * Reads the content of restart-state.json (`{ version: 1, jobs: { <id>: { attempt, restarts: [ms...] } } }`) without trusting it.
 * A restart moment after `nowMs` (the clock went back) is dropped and said, as a moment in the future would count for ever.
 */
export function parseRestartStates(raw: unknown, nowMs: number): ParsedRestartStates {
  const states = new Map<string, RestartState>();
  const entryProblems: ParsedRestartStates['entryProblems'] = [];
  const unusable = (fileProblem: string): ParsedRestartStates => ({ states: new Map(), entryProblems: [], fileProblem });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return unusable(`it holds ${show(raw)?.slice(0, 40)} instead of an object`);
  }
  const version = Reflect.get(raw, 'version');
  if (version !== 1) {
    return unusable(`its version is ${show(version)}, this daemon reads version 1 (written by another orch version?)`);
  }
  const jobs = Reflect.get(raw, 'jobs');
  if (typeof jobs !== 'object' || jobs === null || Array.isArray(jobs)) {
    return unusable('it has no "jobs" object');
  }
  for (const [jobId, entry] of Object.entries(jobs)) {
    if (!isRestartEntry(entry)) {
      entryProblems.push({ jobId, problem: `its entry is invalid (${show(entry)?.slice(0, 80)}), expected { attempt: whole number, restarts: [ms...] }`, dropped: true });
      continue;
    }
    const past = entry.restarts.filter(t => t <= nowMs);
    if (past.length !== entry.restarts.length) {
      entryProblems.push({ jobId, problem: `${entry.restarts.length - past.length} restart moment(s) are in the future (the clock went back?) and were ignored`, dropped: false });
    }
    states.set(jobId, { attempt: entry.attempt, restarts: past });
  }
  return { states, entryProblems, fileProblem: null };
}
