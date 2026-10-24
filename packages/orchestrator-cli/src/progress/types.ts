import type { Job, RuntimeEntry } from '../types.js';

/*
 * The strategy interface (plan: .claude/plans/2026-10-18_job-progress-and-eta.md, section 4).
 *
 * Strategies are built in and declarative: this is an internal interface, NOT a plugin API. No external code is
 * loaded; a user configures a strategy with patterns and JSON only (see the threat model entry "progress").
 * Log access is in log-corpus.ts, the learned-data store in store.ts.
 */

export interface LogLine {
  /** From the "[YYYY-MM-DD HH:MM:SS]" prefix (UTC); a line without one keeps the previous line's. */
  ts: Date;
  /** At most 2000 characters. */
  text: string;
}

export interface LogReader {
  exists(): boolean;
  /** Bytes in the file (0 when missing); lets a caller budget its reads. Optional: replay wrappers omit it. */
  size?(): number;
  /** Complete lines from a byte offset, at most the reader's byte cap per call. `truncated`: more is left. */
  readFrom(offset: number): { lines: LogLine[]; nextOffset: number; truncated: boolean };
  /** The last complete lines within the last `maxBytes` bytes. */
  tail(maxBytes: number): LogLine[];
  /** Hash of the first masked lines, for format-change detection; '' for an empty log. */
  fingerprint(): string;
}

export interface LogCorpus {
  currentRun(): LogReader;
  /** Usable runs (see isUsableRun), newest first, at most `limit`: history entries plus runs only a log remembers. */
  pastRuns(limit: number): Array<{ entry: RuntimeEntry; reader: LogReader }>;
}

export interface StoreMeta {
  logFingerprint?: string;
  learnedFromRuns?: string[];
}

/**
 * Learned data for one job and one strategy, in <configDir>/progress/<jobId>.json. It is derived and
 * rebuildable: a read never throws, and returns undefined when there is nothing valid (no data, other strategy
 * version, the job's command changed, the file was unreadable); the drop is logged.
 */
export interface StrategyStore {
  read(): unknown;
  write(data: unknown, meta?: StoreMeta): void;
  meta(): StoreMeta | undefined;
  invalidate(reason: string): void;
}

export interface ProgressContext {
  job: Job;
  configDir: string;
  /** The open run being estimated. */
  run: { startedAt: string; pid: number | null };
  /** All runs of the job, open ones included, in no guaranteed order; at most 20 (state.ts MAX_HISTORY). */
  history: ReadonlyArray<RuntimeEntry>;
  logs: LogCorpus;
  now(): Date;
  options: unknown;
  store: StrategyStore;
}

export type ProgressConfidence = 'high' | 'medium' | 'low' | 'none';

export interface ProgressEstimate {
  /** The strategy that produced the numbers; null when none ran (long-running job, RPC failure). */
  strategyId: string | null;
  /** 0..1, or null when there is no estimate. */
  progress: number | null;
  /** Absolute ISO time; null when there is no estimate or the run is past its usual duration. */
  etaAt: string | null;
  confidence: ProgressConfidence;
  /** 0..1. */
  confidenceScore: number;
  /** Always set. When progress is null it says why and what to do. */
  reason: string;
  /** The daemon clock when this was computed, so a client can compute the remaining time without trusting its own clock. */
  serverNow: string;
  detail?: Record<string, unknown>;
}

/** What a strategy needs to learn from the runs that ended: no open run, no options. */
export interface LearnContext {
  job: Job;
  configDir: string;
  history: ReadonlyArray<RuntimeEntry>;
  logs: LogCorpus;
  now(): Date;
  store: StrategyStore;
}

export interface ProgressStrategy {
  /** [a-z0-9-]+, like a job id. */
  readonly id: string;
  /** Bump to invalidate stored learned data. */
  readonly version: number;
  validateOptions(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  /** Sync, cheap, no network. Pure over its inputs and the store. */
  estimate(ctx: ProgressContext): ProgressEstimate;
  /**
   * Optional: reads the logs of the runs that ended into the store, within the strategy's byte budget, so the next
   * estimate has nothing left to learn. Idempotent (a run already learned is skipped), sync, and may throw: the caller
   * reports it. Returns how many runs it learned just now.
   */
  learn?(ctx: LearnContext): number;
}
