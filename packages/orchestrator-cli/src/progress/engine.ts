import type { Job, RuntimeEntry } from '../types.js';
import { isLongRunning } from '../long-running.js';
import { historyStrategy } from './history-strategy.js';
import type { LogCorpus, ProgressContext, ProgressEstimate, ProgressStrategy, StrategyStore } from './types.js';

/**
 * The built-in strategies. Today only `history`; adding one means adding it here AND to the `auto` order in
 * `candidatesFor`. There is no external plugin loading and no per-job `progress` setting yet: every job is `auto`.
 */
export const STRATEGIES: readonly ProgressStrategy[] = [historyStrategy];

const NOT_AVAILABLE = (what: string): Error => new Error(
  `${what} is not available: only the history strategy exists in this release and it reads run history only`);

/** Log access is part of the contract but nothing provides it yet; a strategy that asks gets an error, not an empty answer. */
export const NO_LOGS: LogCorpus = {
  currentRun() { throw NOT_AVAILABLE('log access'); },
  pastRuns() { throw NOT_AVAILABLE('log access'); },
};

export const NO_STORE: StrategyStore = {
  read() { throw NOT_AVAILABLE('the learned-data store'); },
  write() { throw NOT_AVAILABLE('the learned-data store'); },
};

function noEstimate(strategyId: string | null, reason: string, now: Date): ProgressEstimate {
  return { strategyId, progress: null, etaAt: null, confidence: 'none', confidenceScore: 0, reason, serverNow: now.toISOString() };
}

/** Checks the contract a strategy owes; returns the problem, or null. */
function contractViolation(e: ProgressEstimate): string | null {
  if (e.progress !== null && !(typeof e.progress === 'number' && e.progress >= 0 && e.progress <= 1)) {
    return `progress ${String(e.progress)} is out of range (0..1)`;
  }
  if (e.progress === null && (typeof e.reason !== 'string' || e.reason.trim() === '')) {
    return 'progress is null without a reason';
  }
  if (e.etaAt !== null && Number.isNaN(Date.parse(e.etaAt))) {
    return `etaAt "${e.etaAt}" is not a date`;
  }
  return null;
}

/** Runs one strategy; a throw or a contract violation becomes a reasoned "no estimate", logged, never an abort. */
function runStrategy(strategy: ProgressStrategy, ctx: ProgressContext, log: (line: string) => void): ProgressEstimate {
  let problem: string;
  try {
    const estimate = strategy.estimate(ctx);
    const violation = contractViolation(estimate);
    if (violation === null) {
      return estimate;
    }
    problem = violation;
  } catch (err) {
    // violations-suppress: ts/no-err-message-direct instanceof-guarded accessor
    problem = err instanceof Error ? err.message : String(err);
  }
  log(`[progress] job ${ctx.job.id}: strategy ${strategy.id} failed: ${problem}`);
  return noEstimate(strategy.id, `strategy ${strategy.id} failed: ${problem}; this is a bug in the strategy, see: orch logs`, ctx.now());
}

/**
 * `auto`: the first candidate that gives an estimate wins, and the reason says which one and why the earlier ones
 * were skipped. With no taker, the result is "no estimate" listing every skip reason.
 */
export function selectAuto(
  candidates: readonly ProgressStrategy[],
  ctx: ProgressContext,
  log: (line: string) => void = () => {},
): ProgressEstimate {
  const skipped: string[] = [];
  for (const strategy of candidates) {
    const estimate = runStrategy(strategy, ctx, log);
    if (estimate.confidence !== 'none') {
      const skips = skipped.length > 0 ? `; skipped ${skipped.join(', ')}` : '';
      return { ...estimate, reason: `auto: ${estimate.strategyId ?? strategy.id} (${estimate.reason})${skips}` };
    }
    skipped.push(`${strategy.id}: ${estimate.reason}`);
  }
  const first = candidates[0];
  return noEstimate(first && candidates.length === 1 ? first.id : null, `auto: ${skipped.join('; ')}`, ctx.now());
}

export interface EstimateProgressInput {
  jobs: readonly Job[];
  /** Run history per job id, as State.getAll() returns it. */
  history: Readonly<Record<string, readonly RuntimeEntry[]>>;
  now(): Date;
  /** Restrict the answer to these jobs. */
  jobIds?: readonly string[];
  log?: (line: string) => void;
  /** Test seam: the candidates for a job, or undefined for the built-in ones. */
  strategies?: (job: Job) => readonly ProgressStrategy[] | undefined;
}

/**
 * One estimate per job that has an open run (finishedAt absent). Jobs that are not running are absent from the
 * answer. A job with several open runs gets one estimate, from the oldest.
 */
export function estimateProgress(input: EstimateProgressInput): Record<string, ProgressEstimate> {
  const log = input.log ?? (() => {});
  const wanted = input.jobIds ? new Set(input.jobIds) : null;
  const result: Record<string, ProgressEstimate> = {};

  for (const job of input.jobs) {
    if (wanted && !wanted.has(job.id)) {
      continue;
    }
    const runs = input.history[job.id] ?? [];
    const oldestOpen = runs.filter(e => !e.finishedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
    if (!oldestOpen) {
      continue;
    }
    if (isLongRunning(job)) {
      result[job.id] = noEstimate(null, 'no completion expected (no timeout)', input.now());
      continue;
    }
    const ctx: ProgressContext = {
      job,
      run: { startedAt: oldestOpen.startedAt, pid: oldestOpen.pid },
      history: runs,
      logs: NO_LOGS,
      now: input.now,
      options: undefined,
      store: NO_STORE,
    };
    result[job.id] = selectAuto(input.strategies?.(job) ?? STRATEGIES, ctx, log);
  }
  return result;
}
