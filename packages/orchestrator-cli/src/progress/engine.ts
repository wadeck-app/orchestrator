import type { Job, RuntimeEntry } from '../types.js';
import { isLongRunning } from '../long-running.js';
import { createLogCorpus } from './log-corpus.js';
import { AUTO_STRATEGIES, STRATEGIES } from './registry.js';
import { PROGRESS_STRATEGY_IDS, resolveProgressSetting } from './setting.js';
import type { JsonWriter } from './async-writer.js';
import { openProgressFile, type ProgressFile } from './store.js';
import type { ProgressContext, ProgressEstimate, ProgressStrategy } from './types.js';

export { STRATEGIES };

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
  file?: ProgressFile,
): ProgressEstimate {
  const skipped: string[] = [];
  const before = file?.chosen(ctx.run.startedAt);
  for (const strategy of candidates) {
    const estimate = runStrategy(strategy, file ? { ...ctx, store: file.storeFor(strategy) } : ctx, log);
    if (estimate.confidence !== 'none') {
      const id = estimate.strategyId ?? strategy.id;
      const skips = skipped.length > 0 ? `; skipped ${skipped.join(', ')}` : '';
      // The choice is recorded for the run, so a later look can tell a stable pick from a flip.
      file?.setChosen(ctx.run.startedAt, id, ctx.now());
      const chosenAt = file?.chosen(ctx.run.startedAt)?.chosenAt ?? ctx.now().toISOString();
      const flip = before !== undefined && before.strategyId !== id
        ? `; this run was estimated by ${before.strategyId} earlier`
        : '';
      return {
        ...estimate,
        reason: `auto: ${id} (${estimate.reason})${skips}${flip}`,
        detail: { ...estimate.detail, chosenAt, ...(flip ? { previouslyChosen: before!.strategyId } : {}) },
      };
    }
    skipped.push(`${strategy.id}: ${estimate.reason}`);
  }
  const first = candidates[0];
  return noEstimate(first && candidates.length === 1 ? first.id : null, `auto: ${skipped.join('; ')}`, ctx.now());
}

export interface EstimateProgressInput {
  /** The daemon's config dir: logs are read from <configDir>/logs, learned data is kept in <configDir>/progress. */
  configDir: string;
  jobs: readonly Job[];
  /** Run history per job id, as State.getAll() returns it. */
  history: Readonly<Record<string, readonly RuntimeEntry[]>>;
  now(): Date;
  /** Restrict the answer to these jobs. */
  jobIds?: readonly string[];
  log?: (line: string) => void;
  /** Test seam: where the learned data is saved (default: the daemon's non-blocking writer). */
  writer?: JsonWriter;
  /** Test seam: the candidates for a job, or undefined for the built-in ones. */
  strategies?: (job: Job) => readonly ProgressStrategy[] | undefined;
}

/**
 * One estimate per job that has an open run (finishedAt absent). Jobs that are not running are absent from the
 * answer. A job with several open runs gets one estimate, from the oldest.
 */
export function estimateProgress(input: EstimateProgressInput): Record<string, ProgressEstimate> {
  if (typeof input.configDir !== 'string' || input.configDir === '') {
    throw new Error('estimateProgress needs configDir: the log files and the learned data live under it');
  }
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
    const setting = resolveProgressSetting(job.progress);
    if (setting.kind === 'off') {
      result[job.id] = noEstimate(null, `progress is off for this job (orch edit ${job.id} --progress auto to enable)`, input.now());
      continue;
    }
    if (isLongRunning(job)) {
      result[job.id] = noEstimate(null, 'no completion expected (no timeout)', input.now());
      continue;
    }
    const seam = input.strategies?.(job);
    const file = openProgressFile({ configDir: input.configDir, jobId: job.id, job, log, ...(input.writer ? { writer: input.writer } : {}) });
    const ctx: ProgressContext = {
      job,
      configDir: input.configDir,
      run: { startedAt: oldestOpen.startedAt, pid: oldestOpen.pid },
      history: runs,
      logs: createLogCorpus({ configDir: input.configDir, jobId: job.id, history: runs, currentStartedAt: oldestOpen.startedAt }),
      now: input.now,
      options: undefined,
      // Replaced by the strategy's own store when it runs (selectAuto, runExplicit).
      store: file.storeFor({ id: 'unassigned', version: 0 }),
    };
    if (setting.kind === 'auto') {
      result[job.id] = selectAuto(seam ?? AUTO_STRATEGIES, ctx, log, file);
      continue;
    }
    result[job.id] = runExplicit(setting.id, setting.options, seam ?? STRATEGIES, ctx, log, file);
  }
  return result;
}

/**
 * An explicit strategy: only that one is asked, and its answer is the answer, a "no estimate" included.
 * The setting was validated when stored, but a registry written by another version can name a strategy this
 * daemon lacks, or options it no longer accepts: that is a reason with the fix, not a crash.
 */
function runExplicit(
  id: string,
  rawOptions: unknown,
  candidates: readonly ProgressStrategy[],
  ctx: ProgressContext,
  log: (line: string) => void,
  file: ProgressFile,
): ProgressEstimate {
  const fix = `fix: orch edit ${ctx.job.id} --progress auto`;
  const strategy = candidates.find(s => s.id === id);
  if (!strategy) {
    const known = [...new Set([...PROGRESS_STRATEGY_IDS, ...candidates.map(s => s.id)])].join(', ');
    return noEstimate(null, `progress strategy "${id}" is set for this job but not registered in this daemon (registered: ${known}); ${fix}`, ctx.now());
  }
  const checked = strategy.validateOptions(rawOptions);
  if (!checked.ok) {
    return noEstimate(id, `the stored options of progress strategy "${id}" are invalid: ${checked.error}; ${fix}`, ctx.now());
  }
  return runStrategy(strategy, { ...ctx, options: checked.value, store: file.storeFor(strategy) }, log);
}
