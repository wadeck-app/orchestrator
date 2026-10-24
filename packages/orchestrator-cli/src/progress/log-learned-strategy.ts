import { mask } from './log-corpus.js';
import { clamp01, levelOfScore, noEstimate, brief } from './estimate-utils.js';
import { formatDuration, median } from './history-strategy.js';
import type { LogCorpus, LogLine, ProgressContext, ProgressEstimate, ProgressStrategy } from './types.js';

/**
 * `log-learned`: the job's own log is the progress bar. Lines are reduced to a "shape" (numbers, hex ids and
 * paths masked); a shape that shows up in most usable runs at a stable fraction of the run is a milestone. The
 * current run is placed between the last milestone it reached and the next one, at the pace it showed so far.
 *
 * Built in and declarative: it runs no user code and no user pattern. Learned data lives in the store, per past
 * run (so a replay that only looks at older runs cannot see newer ones), and is read lazily within a byte budget.
 */

/** Usable runs with a log that are needed before the strategy gives an estimate. */
export const LEARNED_MIN_RUNS = 3;
/** The newest usable runs learned from. */
export const LEARNED_WINDOW = 20;
/** Bytes of past logs read by one estimate; the rest is learned by the next ones. */
export const LEARN_BYTE_BUDGET = 1024 * 1024;
export const DEFAULT_MIN_SUPPORT_PERCENT = 60;
/** A milestone whose relative time varies more than this (interquartile range, fraction of the run) is dropped. */
export const MAX_MILESTONE_IQR = 0.15;
/** Under this usual duration the 1 s log resolution is too coarse for milestones. */
export const MIN_LEARNED_DURATION_MS = 10_000;

const SHAPE_MAX_CHARS = 120;
const MAX_SHAPES_PER_RUN = 400;
const HEAD_LINES = 20;
const MAX_MILESTONES = 50;
/** Milestones very near the start say nothing. */
const MIN_MILESTONE_REL = 0.03;
/** A run that is more than this many times faster or slower than usual is not trusted to rescale the pace. */
const MAX_PACE_FACTOR = 10;
const MIN_PACE_GAP_MS = 3000;
const MIN_PACE_REL_GAP = 0.05;
const PROGRESS_CAP = 0.99;
/** Share of the current log's first shapes a past run's head must contain to count as the same log format. */
const FORMAT_CONTAINMENT = 0.5;

export interface RunShapes {
  durationMs: number;
  /** The masked first lines of the run's log, to tell a log format change. */
  head: string[];
  /** shape -> fraction of the run (0..1) at which it first appeared. */
  shapes: Record<string, number>;
  /** The run had no log file: it counts for nothing. */
  missing?: boolean;
}

export interface LearnedData {
  runs: Record<string, RunShapes>;
}

interface Options {
  minSupportPercent: number;
}

function validate(raw: unknown): { ok: true; value: Options } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: true, value: { minSupportPercent: DEFAULT_MIN_SUPPORT_PERCENT } };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'options must be an object like {"minSupportPercent": 60}, or omitted' };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'minSupportPercent') {
      return { ok: false, error: `unknown option "${key}" (accepted: minSupportPercent)` };
    }
  }
  const v = (raw as { minSupportPercent?: unknown }).minSupportPercent;
  if (v === undefined) {
    return { ok: true, value: { minSupportPercent: DEFAULT_MIN_SUPPORT_PERCENT } };
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 10 || v > 100) {
    return { ok: false, error: '"minSupportPercent" must be a whole number from 10 to 100 (the share of usable runs a log line must appear in)' };
  }
  return { ok: true, value: { minSupportPercent: v } };
}

/** The masked shapes of a log's lines, in order, and the time each shape first appeared. */
function scan(lines: readonly LogLine[]): { head: string[]; first: Map<string, number> } {
  const head: string[] = [];
  const first = new Map<string, number>();
  for (const line of lines) {
    if (line.text === '' || line.text.startsWith('[job:')) {
      continue;
    }
    const shape = mask(line.text).slice(0, SHAPE_MAX_CHARS);
    if (!/[A-Za-z]/.test(shape)) {
      continue;
    }
    if (head.length < HEAD_LINES) {
      head.push(shape);
    }
    if (!first.has(shape) && first.size < MAX_SHAPES_PER_RUN) {
      first.set(shape, line.ts.getTime());
    }
  }
  return { head, first };
}

type PastRun = ReturnType<LogCorpus['pastRuns']>[number];

/**
 * Reads the past runs `data` does not know yet, newest first, until `budgetBytes` have been read (the first run
 * is always read, so a log larger than the budget is still learned). Keeps the newest 20 runs.
 * Returns whether `data` changed and how many of `past` are still unread.
 */
export function learnInto(data: LearnedData, past: readonly PastRun[], budgetBytes: number): { changed: boolean; pending: number } {
  let changed = false;
  let spent = 0;
  for (const run of past) {
    const key = run.entry.startedAt;
    if (data.runs[key] !== undefined) {
      continue;
    }
    if (spent > 0 && spent >= budgetBytes) {
      break;
    }
    const startMs = Date.parse(key);
    const durationMs = Date.parse(run.entry.finishedAt!) - startMs;
    if (!run.reader.exists()) {
      data.runs[key] = { durationMs, head: [], shapes: {}, missing: true };
      changed = true;
      continue;
    }
    const got = run.reader.readFrom(0);
    spent += got.nextOffset;
    const { head, first } = scan(got.lines);
    const shapes: Record<string, number> = {};
    for (const [shape, ts] of first) {
      shapes[shape] = durationMs > 0 ? Math.round(clamp01((ts - startMs) / durationMs) * 10_000) / 10_000 : 0;
    }
    data.runs[key] = { durationMs, head, shapes };
    changed = true;
  }
  // Only the newest runs are kept. Not "the runs in `past`": a replay asks for the runs older than one of them
  // and must not make the store forget the newer ones.
  const keys = Object.keys(data.runs).sort();
  for (const key of keys.slice(0, Math.max(0, keys.length - LEARNED_WINDOW))) {
    delete data.runs[key];
    changed = true;
  }
  return { changed, pending: past.filter(p => data.runs[p.entry.startedAt] === undefined).length };
}

export interface Milestone {
  shape: string;
  /** Median fraction of the run at which the shape first appears. */
  rel: number;
  iqr: number;
  support: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Shapes in at least `minSupportPercent` of `runs`, at a stable relative time, ordered by that time. */
export function mineMilestones(runs: readonly RunShapes[], minSupportPercent: number): Milestone[] {
  const rels = new Map<string, number[]>();
  for (const run of runs) {
    for (const [shape, rel] of Object.entries(run.shapes)) {
      const list = rels.get(shape);
      if (list) {
        list.push(rel);
      } else {
        rels.set(shape, [rel]);
      }
    }
  }
  const out: Milestone[] = [];
  for (const [shape, list] of rels) {
    if (list.length * 100 < minSupportPercent * runs.length) {
      continue;
    }
    const sorted = [...list].sort((a, b) => a - b);
    const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
    const rel = quantile(sorted, 0.5);
    if (iqr > MAX_MILESTONE_IQR || rel < MIN_MILESTONE_REL) {
      continue;
    }
    out.push({ shape, rel, iqr, support: list.length / runs.length });
  }
  return out.sort((a, b) => a.iqr - b.iqr).slice(0, MAX_MILESTONES).sort((a, b) => a.rel - b.rel);
}

/** Share of the current head's shapes that a past run's head also has. */
function sameFormat(currentHead: readonly string[], pastHead: readonly string[]): boolean {
  if (currentHead.length === 0) {
    return true;
  }
  const have = new Set(pastHead);
  return currentHead.filter(s => have.has(s)).length / currentHead.length >= FORMAT_CONTAINMENT;
}

export interface LogLearnedDeps {
  learnByteBudget?: number;
}

export function createLogLearnedStrategy(deps: LogLearnedDeps = {}): ProgressStrategy {
  const budget = deps.learnByteBudget ?? LEARN_BYTE_BUDGET;

  return {
    id: 'log-learned',
    version: 1,
    validateOptions: validate,

    estimate(ctx: ProgressContext): ProgressEstimate {
      const now = ctx.now();
      const nowMs = now.getTime();
      const startMs = Date.parse(ctx.run.startedAt);
      const none = (reason: string, detail?: Record<string, unknown>): ProgressEstimate => noEstimate('log-learned', now, reason, detail);
      const fix = `or use the run history instead: orch edit ${ctx.job.id} --progress history`;

      const checked = validate(ctx.options);
      if (!checked.ok) {
        return none(`the options of the log-learned strategy are not usable: ${checked.error}; fix: orch edit ${ctx.job.id} --progress log-learned`);
      }
      const minSupport = checked.value.minSupportPercent;

      // Learn from the past runs not read yet, within the byte budget.
      const past = ctx.logs.pastRuns(LEARNED_WINDOW);
      const stored = ctx.store.read() as LearnedData | undefined;
      const data: LearnedData = stored && typeof stored.runs === 'object' && stored.runs !== null ? stored : { runs: {} };
      const learned = learnInto(data, past, budget);
      if (learned.changed) {
        ctx.store.write(data, {
          logFingerprint: past[0] ? past[0].reader.fingerprint() : '',
          learnedFromRuns: Object.keys(data.runs),
        });
      }
      const learning = learned.pending > 0
        ? ` (learning: ${past.length - learned.pending} of ${past.length} past runs read, the rest follow on the next estimates)`
        : '';

      if (past.length === 0) {
        return none(`no usable run log yet: milestones are learned from finished runs that left a log (exit code 0); run the job to completion ${LEARNED_MIN_RUNS} times, ${fix}`);
      }

      // The current log: the shapes seen so far and when.
      const current = scan(ctx.logs.currentRun().readFrom(0).lines);

      const withLog = past.map(p => data.runs[p.entry.startedAt]).filter((r): r is RunShapes => r !== undefined && r.missing !== true);
      const matching = withLog.filter(r => sameFormat(current.head, r.head));
      if (matching.length < LEARNED_MIN_RUNS) {
        if (withLog.length >= LEARNED_MIN_RUNS) {
          const need = LEARNED_MIN_RUNS - matching.length;
          return none(
            `log format changed, relearning (needs ${need} more run${need === 1 ? '' : 's'} with the new log format; ${matching.length} of ${withLog.length} usable runs match); ${fix}${learning}`,
            { usableRuns: matching.length, formatChanged: true });
        }
        return none(`needs ${LEARNED_MIN_RUNS} usable runs with a log, has ${withLog.length}${learning}; ${fix}`, { usableRuns: withLog.length });
      }

      const durations = matching.map(r => r.durationMs).filter(d => d >= 0).sort((a, b) => a - b);
      const usualMs = median(durations);
      if (usualMs < MIN_LEARNED_DURATION_MS) {
        return none(
          `the usual duration is ${formatDuration(usualMs)}: log timestamps have a 1 s resolution, too coarse for log milestones; ${fix}`,
          { usableRuns: matching.length, usualMs });
      }

      const milestones = mineMilestones(matching, minSupport);
      if (milestones.length < 2) {
        return none(
          `no stable milestone in the last ${matching.length} usable runs (a log line must appear in ${minSupport} % of them at a similar point of the run; found ${milestones.length}); ${fix}${learning}`,
          { usableRuns: matching.length, milestones: milestones.length });
      }

      // Where the current run is: the milestone seen with the largest expected position, and the one before it.
      const seen = milestones
        .map((m, idx) => ({ m, idx, ts: current.first.get(m.shape) }))
        .filter((s): s is { m: Milestone; idx: number; ts: number } => s.ts !== undefined)
        .map(s => ({ ...s, elapsed: Math.max(0, s.ts - startMs) }));
      const last = seen.length > 0 ? seen.reduce((a, b) => (b.m.rel > a.m.rel ? b : a)) : undefined;
      const prev = last ? seen.filter(s => s.m.rel < last.m.rel).reduce<typeof last | undefined>((a, b) => (a === undefined || b.m.rel > a.m.rel ? b : a), undefined) : undefined;
      const next = milestones.find(m => (last ? m.rel > last.m.rel : true) && current.first.get(m.shape) === undefined);

      const relB = last?.m.rel ?? 0;
      const elapsedB = last?.elapsed ?? 0;
      let paceMs = usualMs;
      let paceFrom = 'the usual duration';
      if (last && prev && last.m.rel - prev.m.rel >= MIN_PACE_REL_GAP && last.elapsed - prev.elapsed >= MIN_PACE_GAP_MS) {
        paceMs = (last.elapsed - prev.elapsed) / (last.m.rel - prev.m.rel);
        paceFrom = 'the last two milestones';
      } else if (last && last.m.rel >= MIN_PACE_REL_GAP && last.elapsed >= MIN_PACE_GAP_MS) {
        paceMs = last.elapsed / last.m.rel;
        paceFrom = 'the time to the last milestone';
      }
      const clamped = Math.min(usualMs * MAX_PACE_FACTOR, Math.max(usualMs / MAX_PACE_FACTOR, paceMs));
      if (clamped !== paceMs) {
        paceFrom = 'the usual duration (the observed pace is implausible)';
      }
      paceMs = clamped;

      const elapsedMs = Math.max(0, nowMs - startMs);
      let progress = relB + (elapsedMs - elapsedB) / paceMs;
      let endMs = startMs + elapsedB + (1 - relB) * paceMs;
      let behind = false;
      if (next && progress >= next.rel - 0.005) {
        // The next milestone is late: wait just below it, and move the end by the lateness.
        progress = next.rel - 0.005;
        behind = true;
        endMs = nowMs + (1 - progress) * paceMs;
      }
      progress = clamp01(Math.min(PROGRESS_CAP, Math.max(relB, progress)));
      const overdue = endMs < nowMs;

      const expectedBefore = milestones.filter(m => m.rel <= relB).length;
      const coverage = expectedBefore === 0 ? 1 : seen.filter(s => s.m.rel <= relB).length / expectedBefore;
      const stability = clamp01(1 - milestones.reduce((a, m) => a + m.iqr, 0) / milestones.length / MAX_MILESTONE_IQR);
      let score = clamp01(0.4 * stability + 0.3 * Math.min(1, milestones.length / 5) + 0.3 * coverage);
      if (!last) {
        score *= 0.6;
      }
      const confidence = matching.length < 5 ? 'low' : levelOfScore(score);

      const factor = paceMs / usualMs;
      const where = last
        ? `last seen "${brief(last.m.shape, 50)}" (${Math.round(last.m.rel * 100)} %)${next ? `, next expected "${brief(next.shape, 50)}" at ${Math.round(next.rel * 100)} %` : ', no later milestone'}`
        : `no milestone seen yet${next ? `, first expected "${brief(next.shape, 50)}" at ${Math.round(next.rel * 100)} %` : ''}`;
      const reason = `learned from ${matching.length} usable runs, ${milestones.length} stable milestones: ${where}; pace x${factor.toFixed(1)} of the usual ${formatDuration(usualMs)} (from ${paceFrom})`
        + `${overdue ? '; longer than usual' : ''}${behind ? '; the next milestone is later than expected' : ''}${learning}`;

      return {
        strategyId: 'log-learned',
        progress,
        etaAt: overdue ? null : new Date(Math.round(endMs)).toISOString(),
        confidence,
        confidenceScore: score,
        reason,
        serverNow: now.toISOString(),
        detail: {
          usableRuns: matching.length,
          milestones: milestones.length,
          usualMs,
          paceMs,
          behind,
          overdue,
          lastSeen: last ? { shape: last.m.shape, rel: last.m.rel } : null,
          nextExpected: next ? { shape: next.shape, rel: next.rel } : null,
          elapsedMs,
        },
      };
    },
  };
}

export const logLearnedStrategy: ProgressStrategy = createLogLearnedStrategy();
