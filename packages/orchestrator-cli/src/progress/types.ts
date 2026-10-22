import type { Job, RuntimeEntry } from '../types.js';

/*
 * The progress plugin contract (plan: .claude/plans/2026-10-18_job-progress-and-eta.md, section 4).
 *
 * Only the built-in `history` strategy exists. LogCorpus, LogReader and StrategyStore are part of the contract
 * so a later strategy has somewhere to read from; nothing implements them yet (see NO_LOGS / NO_STORE in
 * engine.ts, which fail loudly when used).
 */

export interface LogReader {
  readFrom(offset: number): { lines: Array<{ ts: Date; text: string }>; nextOffset: number };
  /** Hash of the first N masked lines, for format-change detection. */
  fingerprint(): string;
}

export interface LogCorpus {
  currentRun(): LogReader;
  pastRuns(limit: number): Array<{ entry: RuntimeEntry; reader: LogReader }>;
}

/** Learned data for one job and one strategy. */
export interface StrategyStore {
  read(): unknown;
  write(data: unknown): void;
}

export interface ProgressContext {
  job: Job;
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

export interface ProgressStrategy {
  /** [a-z0-9-]+, like a job id. */
  readonly id: string;
  /** Bump to invalidate stored learned data. */
  readonly version: number;
  validateOptions(raw: unknown): { ok: true; value: unknown } | { ok: false; error: string };
  /** Sync, cheap, no network. Pure over its inputs and the store. */
  estimate(ctx: ProgressContext): ProgressEstimate;
}
