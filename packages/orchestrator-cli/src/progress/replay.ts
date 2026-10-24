import { getErrorMessage } from '../fsUtil.js';
import type { Job, RuntimeEntry } from '../types.js';
import type { LogCorpus, LogLine, LogReader, ProgressContext, ProgressEstimate, ProgressStrategy, StoreMeta, StrategyStore } from './types.js';

/*
 * The replay harness (plan section 7): every usable past run is replayed as if it were open, at sampled elapsed
 * times, asking each strategy for an estimate with ONLY the runs older than it as history (leave-one-out, no
 * look-ahead) and the run's log cut at the sample time. The ETA is compared with the real end of the run.
 *
 * Used by `orch progress replay` and by the `ensemble` strategy. It touches no file of its own: logs are read
 * through the corpus it is given, learned data lives in memory.
 */

export const DEFAULT_SAMPLE_EVERY_PERCENT = 5;
export const DEFAULT_REPLAY_RUNS = 20;
/** An end time that moves by more than this share of the run's duration between two samples is a flip. */
export const ETA_FLIP_SHARE = 0.2;
const MAX_ERRORS = 5;

export interface ReplayInput {
  job: Job;
  configDir: string;
  /** Its pastRuns() are the usable runs replayed (and used as history), newest first. */
  corpus: LogCorpus;
  strategies: readonly ProgressStrategy[];
  /** 1..50, default 5. */
  sampleEveryPercent?: number;
  /** The newest usable runs considered, default 20. */
  maxRuns?: number;
  /** Which runs are replayed as the open run; the others still serve as history. Default: all. */
  evaluate?: (entry: RuntimeEntry) => boolean;
  /** Raw options per strategy id. */
  options?: Readonly<Record<string, unknown>>;
  /**
   * Stores shared by all runs, per strategy id. Only for a strategy that keys what it learned by run and never
   * reads a run newer than the one replayed (log-learned does); otherwise each run gets a fresh in-memory store.
   */
  stores?: Readonly<Record<string, StrategyStore>>;
}

export interface ReplaySample {
  runStartedAt: string;
  /** Share of the run elapsed, 0..1. */
  fraction: number;
  elapsedMs: number;
  progress: number | null;
  etaAt: string | null;
  confidence: string;
  /** |predicted end - real end|; a progress without an etaAt (overdue) counts as ending at the sample time. */
  errorMs: number | null;
  /** errorMs as a share of the run's duration. */
  errorPct: number | null;
  overdue: boolean;
  reason: string;
}

export interface ErrorAt {
  maeSec: number | null;
  maePct: number | null;
}

export interface ReplayMetrics {
  samples: number;
  /** Samples that carried an estimate. */
  estimated: number;
  /** estimated / samples. */
  coverage: number;
  maeSec: number | null;
  /** Mean absolute ETA error as a share of the run's duration. */
  maePct: number | null;
  /** The error at about 25, 50 and 75 % of the run. */
  byFraction: { 25: ErrorAt; 50: ErrorAt; 75: ErrorAt };
  /** Consecutive samples of a run where progress went down. */
  monotonicityViolations: number;
  /** Consecutive samples of a run whose end time moved by more than 20 % of the duration. */
  etaFlips: number;
}

export interface StrategyReplay {
  samples: ReplaySample[];
  metrics: ReplayMetrics;
  /** Distinct failures of the strategy during the replay (a throw, an unusable option), at most 5. */
  errors: string[];
}

export interface ReplayResult {
  /** Runs replayed. */
  runs: number;
  strategies: Record<string, StrategyReplay>;
}

export function memoryStore(): StrategyStore {
  let data: unknown;
  let meta: StoreMeta | undefined;
  return {
    read: () => data,
    write: (d, m) => { data = d; meta = m; },
    meta: () => meta,
    invalidate: () => { data = undefined; meta = undefined; },
  };
}

/** The reader of the replayed run, showing only what had been logged by `untilMs`. */
function truncatedReader(all: () => LogLine[], exists: () => boolean, untilMs: () => number): LogReader {
  const visible = (): LogLine[] => all().filter(l => l.ts.getTime() <= untilMs());
  return {
    exists,
    readFrom(offset) {
      if (offset !== 0) {
        throw new Error('replay supports readFrom(0) and tail() only; a strategy that reads by offset cannot be replayed until the harness learns it');
      }
      const lines = visible();
      return { lines, nextOffset: lines.length, truncated: false };
    },
    tail(maxBytes) {
      const lines = visible();
      let bytes = 0;
      let from = lines.length;
      while (from > 0 && bytes + lines[from - 1]!.text.length + 22 <= maxBytes) {
        bytes += lines[from - 1]!.text.length + 22;
        from--;
      }
      return lines.slice(from);
    },
    fingerprint: () => '',
  };
}

function mean(xs: readonly number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function metricsOf(samples: readonly ReplaySample[], stepPercent: number): ReplayMetrics {
  const withError = samples.filter(s => s.errorMs !== null);
  const errorAt = (percent: number): ErrorAt => {
    const picked = samples.filter(s => s.errorMs !== null && Math.abs(s.fraction - percent / 100) <= stepPercent / 200 + 1e-9);
    // One sample per run: the nearest to the target.
    const byRun = new Map<string, ReplaySample>();
    for (const s of picked) {
      const cur = byRun.get(s.runStartedAt);
      if (!cur || Math.abs(s.fraction - percent / 100) < Math.abs(cur.fraction - percent / 100)) {
        byRun.set(s.runStartedAt, s);
      }
    }
    const list = [...byRun.values()];
    const sec = mean(list.map(s => s.errorMs! / 1000));
    const pct = mean(list.map(s => s.errorPct!));
    return { maeSec: sec, maePct: pct };
  };

  let monotonicityViolations = 0;
  let etaFlips = 0;
  const byRun = new Map<string, ReplaySample[]>();
  for (const s of samples) {
    const list = byRun.get(s.runStartedAt);
    if (list) {
      list.push(s);
    } else {
      byRun.set(s.runStartedAt, [s]);
    }
  }
  for (const list of byRun.values()) {
    list.sort((a, b) => a.fraction - b.fraction);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      if (a.progress !== null && b.progress !== null && b.progress < a.progress - 1e-9) {
        monotonicityViolations++;
      }
      if (a.etaAt !== null && b.etaAt !== null && a.elapsedMs > 0) {
        const duration = a.elapsedMs / a.fraction;
        if (Math.abs(Date.parse(b.etaAt) - Date.parse(a.etaAt)) > ETA_FLIP_SHARE * duration + 1e-6) {
          etaFlips++;
        }
      }
    }
  }

  const estimated = samples.filter(s => s.progress !== null).length;
  return {
    samples: samples.length,
    estimated,
    coverage: samples.length === 0 ? 0 : estimated / samples.length,
    maeSec: mean(withError.map(s => s.errorMs! / 1000)),
    maePct: mean(withError.map(s => s.errorPct!)),
    byFraction: { 25: errorAt(25), 50: errorAt(50), 75: errorAt(75) },
    monotonicityViolations,
    etaFlips,
  };
}

export function replayJob(input: ReplayInput): ReplayResult {
  const step = input.sampleEveryPercent ?? DEFAULT_SAMPLE_EVERY_PERCENT;
  if (!Number.isInteger(step) || step < 1 || step > 50) {
    throw new Error(`sampleEveryPercent must be a whole number from 1 to 50, got ${String(input.sampleEveryPercent)}`);
  }
  const runs = input.corpus.pastRuns(input.maxRuns ?? DEFAULT_REPLAY_RUNS);
  const result: ReplayResult = { runs: 0, strategies: {} };
  const samplesOf: Record<string, ReplaySample[]> = {};
  const errorsOf: Record<string, string[]> = {};
  for (const s of input.strategies) {
    samplesOf[s.id] = [];
    errorsOf[s.id] = [];
  }

  for (let i = 0; i < runs.length; i++) {
    const { entry, reader } = runs[i]!;
    if (input.evaluate && !input.evaluate(entry)) {
      continue;
    }
    result.runs++;
    const startMs = Date.parse(entry.startedAt);
    const endMs = Date.parse(entry.finishedAt!);
    const durationMs = endMs - startMs;
    const older = runs.slice(i + 1);
    const history: RuntimeEntry[] = [
      { startedAt: entry.startedAt, exitCode: null, pid: entry.pid },
      ...older.map(r => r.entry),
    ];

    let cached: LogLine[] | undefined;
    const allLines = (): LogLine[] => (cached ??= reader.readFrom(0).lines);
    const stores = new Map<string, StrategyStore>();

    for (let k = 1; k * step < 100; k++) {
      const fraction = (k * step) / 100;
      const elapsedMs = Math.round(fraction * durationMs);
      const nowMs = startMs + elapsedMs;
      const logs: LogCorpus = {
        currentRun: () => truncatedReader(allLines, () => reader.exists(), () => nowMs),
        pastRuns: (limit) => older.slice(0, limit),
      };
      for (const strategy of input.strategies) {
        let store = input.stores?.[strategy.id] ?? stores.get(strategy.id);
        if (!store) {
          store = memoryStore();
          stores.set(strategy.id, store);
        }
        const sample = sampleOf(strategy, {
          job: input.job,
          configDir: input.configDir,
          run: { startedAt: entry.startedAt, pid: entry.pid },
          history,
          logs,
          now: () => new Date(nowMs),
          options: undefined,
          store,
        }, input.options?.[strategy.id], errorsOf[strategy.id]!);
        samplesOf[strategy.id]!.push(finishSample(sample, entry.startedAt, fraction, elapsedMs, nowMs, endMs, durationMs));
      }
    }
  }

  for (const strategy of input.strategies) {
    const samples = samplesOf[strategy.id]!;
    result.strategies[strategy.id] = { samples, metrics: metricsOf(samples, step), errors: errorsOf[strategy.id]! };
  }
  return result;
}

function sampleOf(strategy: ProgressStrategy, ctx: ProgressContext, rawOptions: unknown, errors: string[]): ProgressEstimate | null {
  const note = (message: string): void => {
    if (errors.length < MAX_ERRORS && !errors.includes(message)) {
      errors.push(message);
    }
  };
  const checked = strategy.validateOptions(rawOptions);
  if (!checked.ok) {
    note(`the options are not usable: ${checked.error}`);
    return null;
  }
  try {
    return strategy.estimate({ ...ctx, options: checked.value });
  } catch (err) {
    note(getErrorMessage(err));
    return null;
  }
}

function finishSample(
  e: ProgressEstimate | null,
  runStartedAt: string,
  fraction: number,
  elapsedMs: number,
  nowMs: number,
  endMs: number,
  durationMs: number,
): ReplaySample {
  if (e === null || e.progress === null) {
    return {
      runStartedAt, fraction, elapsedMs, progress: null, etaAt: null, confidence: e?.confidence ?? 'none',
      errorMs: null, errorPct: null, overdue: false, reason: e?.reason ?? 'the strategy failed (see errors)',
    };
  }
  const overdue = e.etaAt === null;
  const predicted = e.etaAt === null ? nowMs : Date.parse(e.etaAt);
  const errorMs = Math.abs(predicted - endMs);
  return {
    runStartedAt, fraction, elapsedMs, progress: e.progress, etaAt: e.etaAt, confidence: e.confidence,
    errorMs, errorPct: durationMs > 0 ? errorMs / durationMs : 0, overdue, reason: e.reason,
  };
}
