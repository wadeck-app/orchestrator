import type { RuntimeEntry } from '../types.js';
import type { ProgressConfidence, ProgressContext, ProgressEstimate, ProgressStrategy } from './types.js';

/** How many of the newest usable runs feed the usual duration. */
export const HISTORY_WINDOW = 10;
/** Fewer usable runs than this: no estimate. */
export const HISTORY_MIN_RUNS = 3;
/** Fewer usable runs than this: the estimate is shown but marked low confidence. */
const HISTORY_CONFIDENT_RUNS = 5;
/** Progress never reads 100 % while the run is still open. */
const PROGRESS_CAP = 0.99;

/**
 * A run whose duration says how long the job takes when it works: it ended by itself with exit code 0.
 * Failed, skipped, killed (user, timeout, resource limit), orphaned and still-open runs stop early or tell
 * nothing, and would pull the estimate down.
 *
 * NOT the filter of the 3x anomaly check (state.ts getRollingAvgDurationMs: any finished run with an exit code,
 * failures included, averaged). The two answer different questions; see the plan's risks section.
 */
export function isUsableRun(e: RuntimeEntry): boolean {
  return e.exitCode === 0 && !e.skipped && !e.cancelledByUser && !e.orphaned && e.endReason === undefined && !!e.finishedAt;
}

/** Median of an ascending list. */
export function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Human duration for a reason string: "45 s", "10 min", "1 h 05 min". */
export function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) {
    return `${totalSec} s`;
  }
  const totalMin = Math.round(totalSec / 60);
  if (totalMin < 60) {
    return `${totalMin} min`;
  }
  return `${Math.floor(totalMin / 60)} h ${String(totalMin % 60).padStart(2, '0')} min`;
}

/** Durations (ms) of the newest HISTORY_WINDOW usable runs, newest first. */
export function usableDurations(history: readonly RuntimeEntry[]): number[] {
  return history
    .filter(isUsableRun)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, HISTORY_WINDOW)
    .map(e => Date.parse(e.finishedAt!) - Date.parse(e.startedAt))
    .filter(d => Number.isFinite(d) && d >= 0);
}

function levelOf(score: number, runs: number): ProgressConfidence {
  if (runs < HISTORY_CONFIDENT_RUNS) {
    return 'low';
  }
  return score >= 0.8 ? 'high' : score >= 0.5 ? 'medium' : 'low';
}

function none(ctx: ProgressContext, reason: string, detail?: Record<string, unknown>): ProgressEstimate {
  return {
    strategyId: 'history', progress: null, etaAt: null, confidence: 'none', confidenceScore: 0,
    reason, serverNow: ctx.now().toISOString(), ...(detail ? { detail } : {}),
  };
}

export const historyStrategy: ProgressStrategy = {
  id: 'history',
  version: 1,

  validateOptions(raw) {
    return raw === undefined ? { ok: true, value: undefined } : { ok: false, error: 'the history strategy takes no options' };
  },

  estimate(ctx) {
    const now = ctx.now().getTime();

    // Parallel runs: one estimate per job, from the oldest open run (documented limit of v1).
    const openRuns = ctx.history.filter(e => !e.finishedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const run = openRuns[0];
    if (!run) {
      return none(ctx, `no open run to estimate (job ${ctx.job.id} is not running)`);
    }

    const durations = usableDurations(ctx.history);

    if (durations.length < HISTORY_MIN_RUNS) {
      const missing = HISTORY_MIN_RUNS - durations.length;
      return none(ctx,
        `needs ${HISTORY_MIN_RUNS} usable runs, has ${durations.length} (progress appears after ${missing} more run(s) that end with exit code 0)`,
        { usableRuns: durations.length });
    }

    const sorted = [...durations].sort((a, b) => a - b);
    const usualMs = median(sorted);
    if (usualMs <= 0) {
      return none(ctx,
        `usual duration is 0 (the last ${durations.length} usable runs took no measurable time), so there is nothing to estimate against`,
        { usableRuns: durations.length });
    }
    const mad = median(sorted.map(d => Math.abs(d - usualMs)).sort((a, b) => a - b));
    const score = Math.min(1, Math.max(0, 1 - mad / usualMs));
    const confidence = levelOf(score, durations.length);

    const startMs = Date.parse(run.startedAt);
    // A start in the future (clock change) counts as zero elapsed rather than a negative progress.
    const elapsedMs = Math.max(0, now - startMs);
    const detail: Record<string, unknown> = {
      usualMs, usableRuns: durations.length, runStartedAt: run.startedAt, elapsedMs, overdue: elapsedMs >= usualMs,
    };
    const base = {
      strategyId: 'history', confidence, confidenceScore: score, serverNow: ctx.now().toISOString(), detail,
    };

    if (elapsedMs >= usualMs) {
      return {
        ...base, progress: PROGRESS_CAP, etaAt: null,
        reason: `longer than usual (usual: ${formatDuration(usualMs)})`,
      };
    }
    return {
      ...base,
      progress: Math.min(PROGRESS_CAP, elapsedMs / usualMs),
      etaAt: new Date(startMs + usualMs).toISOString(),
      reason: `median of the last ${durations.length} usable runs: ${formatDuration(usualMs)}`,
    };
  },
};
