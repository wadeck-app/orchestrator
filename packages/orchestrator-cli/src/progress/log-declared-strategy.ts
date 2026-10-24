import { brief, clamp01, levelOfScore, noEstimate } from './estimate-utils.js';
import { formatDuration, median } from './history-strategy.js';
import { DEFAULT_MATCH_BUDGET_MS, compilePattern, matcherFor, type Matcher } from './safe-regex.js';
import type { LogLine, ProgressContext, ProgressEstimate, ProgressStrategy } from './types.js';

/**
 * `log-declared`: the user lists milestones, regexes that match a line of the job's log. Where each milestone falls
 * in the run comes from `at` (a fraction), from `weight` (relative step sizes), or, with neither, from where the
 * milestone fell in past runs. Between two milestones progress is interpolated; the pace observed at the last one
 * rescales the rest. Explicit only: `auto` never picks it, orch cannot guess what a milestone is.
 */

const MAX_MILESTONES = 30;
/** Past runs learned from. */
const PAST_RUNS = 20;
/** Bytes of past logs scanned by one estimate; the rest is scanned by the next ones (cached in the store). */
export const SCAN_BYTE_BUDGET = 4 * 1024 * 1024;
/** Lines matched per matcher call, so the time budget applies to a bounded amount of work. */
const BATCH_LINES = 5000;
/** Runs shorter than this are coarse with a log stamped to the second. */
const SHORT_RUN_MS = 10_000;
const MIN_LEARN_RUNS = 3;
/** Progress stays this fraction of the way to the next milestone until it is seen. */
const HOLD = 0.95;
/** Shortest elapsed time at a milestone that says anything about the pace (log stamps have a 1 s resolution). */
const MIN_PACE_MS = 1000;

interface Milestone {
  pattern: string;
  at?: number;
  weight?: number;
}

interface LogDeclaredOptions {
  milestones: Milestone[];
}

type Positions = Array<number | null>;

const EXAMPLE = '{"milestones": [{"pattern": "Step 1", "at": 0.3}, {"pattern": "Step 2", "at": 0.7}, {"pattern": "Done", "at": 1}]}';

function validate(raw: unknown): { ok: true; value: LogDeclaredOptions } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: false, error: `needs options like ${EXAMPLE}: "at" is the expected fraction of the run when the line appears (or use "weight", or neither to learn it from past runs)` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `options must be an object like ${EXAMPLE}` };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'milestones') {
      return { ok: false, error: `unknown option "${key}" (accepted: milestones)` };
    }
  }
  const list = (raw as { milestones?: unknown }).milestones;
  if (list === undefined) {
    return { ok: false, error: `"milestones" is required: a list of 1 to ${MAX_MILESTONES} like ${EXAMPLE}` };
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_MILESTONES) {
    return { ok: false, error: `"milestones" must be a list of 1 to ${MAX_MILESTONES} milestones, got ${Array.isArray(list) ? `${list.length}` : typeof list}` };
  }
  const out: Milestone[] = [];
  let previousAt = 0;
  for (let i = 0; i < list.length; i++) {
    const m: unknown = list[i];
    const at = `milestones[${i}]`;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) {
      return { ok: false, error: `${at}: must be an object like {"pattern": "Step 1", "at": 0.3}` };
    }
    for (const key of Object.keys(m)) {
      if (key !== 'pattern' && key !== 'at' && key !== 'weight') {
        return { ok: false, error: `${at}: unknown key "${key}" (accepted: pattern, at, weight)` };
      }
    }
    const { pattern, at: atValue, weight } = m as { pattern?: unknown; at?: unknown; weight?: unknown };
    if (pattern === undefined) {
      return { ok: false, error: `${at}: "pattern" is required (a regular expression matching one log line)` };
    }
    const compiled = compilePattern(pattern, { groups: [0, 1, 2, 3] });
    if (!compiled.ok) {
      return { ok: false, error: `${at}: ${compiled.error}` };
    }
    if (atValue !== undefined && weight !== undefined) {
      return { ok: false, error: `${at}: give "at" or "weight", not both` };
    }
    if (atValue !== undefined) {
      if (typeof atValue !== 'number' || !Number.isFinite(atValue) || atValue <= 0 || atValue > 1) {
        return { ok: false, error: `${at}: "at" must be a number above 0 and at most 1 (the fraction of the run, 0.5 = half way)` };
      }
      if (atValue <= previousAt) {
        return { ok: false, error: `${at}: "at" ${atValue} must be above the previous one (${previousAt}); list the milestones in the order they appear` };
      }
      previousAt = atValue;
    }
    if (weight !== undefined && (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0)) {
      return { ok: false, error: `${at}: "weight" must be a number above 0 (the relative size of the step that ends at this milestone)` };
    }
    out.push({ pattern: pattern as string, ...(atValue !== undefined ? { at: atValue } : {}), ...(weight !== undefined ? { weight } : {}) });
  }
  const withAt = out.filter(m => m.at !== undefined).length;
  const withWeight = out.filter(m => m.weight !== undefined).length;
  if (!((withAt === 0 || withAt === out.length) && (withWeight === 0 || withWeight === out.length) && (withAt === 0 || withWeight === 0))) {
    return { ok: false, error: 'use "at" on every milestone, "weight" on every milestone, or neither (then the positions are learned from past runs)' };
  }
  return { ok: true, value: { milestones: out } };
}

/** Per past run: where each milestone first appeared, as a fraction of that run; null = absent. */
interface RunScan {
  rels: Array<number | null>;
  /** The run had no log file: it counts for nothing. */
  missing?: boolean;
}

interface CacheData {
  patterns: string[];
  runs: Record<string, RunScan>;
}

export interface LogDeclaredDeps {
  matcherFor?: (regex: RegExp) => Matcher;
  scanByteBudget?: number;
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export function createLogDeclaredStrategy(deps: LogDeclaredDeps = {}): ProgressStrategy {
  const matcherOf = deps.matcherFor ?? matcherFor;
  const scanBudget = deps.scanByteBudget ?? SCAN_BYTE_BUDGET;

  /** The index of the first line each matcher matches, or -1. Null when the time budget ran out. */
  const firstMatches = (matchers: Matcher[], lines: readonly LogLine[]): number[] | null => {
    const first = matchers.map(() => -1);
    for (let from = 0; from < lines.length; from += BATCH_LINES) {
      const texts = lines.slice(from, from + BATCH_LINES).map(l => l.text);
      for (let k = 0; k < matchers.length; k++) {
        if (first[k]! >= 0) {
          continue;
        }
        const batch = matchers[k]!.matchLines(texts);
        if (batch.timedOut) {
          return null;
        }
        const hit = batch.matches.findIndex(m => m !== null);
        if (hit >= 0) {
          first[k] = from + hit;
        }
      }
    }
    return first;
  };

  return {
    id: 'log-declared',
    version: 1,
    validateOptions: validate,

    estimate(ctx: ProgressContext): ProgressEstimate {
      const now = ctx.now();
      const nowMs = now.getTime();
      const startMs = Date.parse(ctx.run.startedAt);
      const fix = `fix: orch edit ${ctx.job.id} --progress log-declared --progress-options @milestones.json`;
      const none = (reason: string, detail?: Record<string, unknown>): ProgressEstimate => noEstimate('log-declared', now, reason, detail);

      const checked = validate(ctx.options);
      if (!checked.ok) {
        return none(`the options of the log-declared strategy are not usable: ${checked.error}; ${fix}`);
      }
      const { milestones } = checked.value;
      const patterns = milestones.map(m => m.pattern);
      const matchers = milestones.map(m => matcherOf((compilePattern(m.pattern) as { ok: true; regex: RegExp }).regex));
      const slow = (): ProgressEstimate => none(
        `a milestone pattern exceeded the ${DEFAULT_MATCH_BUDGET_MS} ms match budget on a log line; simplify the patterns (anchor them with ^, avoid nested repetition); ${fix}`);

      // Past runs: scan the ones not cached yet, within the byte budget.
      const past = ctx.logs.pastRuns(PAST_RUNS);
      let cache = ctx.store.read() as CacheData | undefined;
      if (cache && JSON.stringify(cache.patterns) !== JSON.stringify(patterns)) {
        ctx.store.invalidate('the milestone patterns changed');
        cache = undefined;
      }
      const data: CacheData = cache ?? { patterns, runs: {} };
      let spent = 0;
      let wrote = false;
      for (const run of past) {
        if (data.runs[run.entry.startedAt] !== undefined) {
          continue;
        }
        if (spent >= scanBudget) {
          break;
        }
        if (!run.reader.exists()) {
          data.runs[run.entry.startedAt] = { rels: milestones.map(() => null), missing: true };
          wrote = true;
          continue;
        }
        const got = run.reader.readFrom(0);
        spent += got.nextOffset;
        const hits = firstMatches(matchers, got.lines);
        if (hits === null) {
          return slow();
        }
        const runStart = Date.parse(run.entry.startedAt);
        const duration = Date.parse(run.entry.finishedAt!) - runStart;
        data.runs[run.entry.startedAt] = {
          rels: hits.map(h => (h < 0 || duration < MIN_PACE_MS ? null : clamp01((got.lines[h]!.ts.getTime() - runStart) / duration))),
        };
        wrote = true;
      }
      if (wrote) {
        ctx.store.write(data, { learnedFromRuns: Object.keys(data.runs) });
      }

      const scans = past.map(p => data.runs[p.entry.startedAt]).filter((s): s is RunScan => s !== undefined && s.missing !== true);
      const durations = past.map(p => Date.parse(p.entry.finishedAt!) - Date.parse(p.entry.startedAt)).filter(d => d >= 0).sort((a, b) => a - b);
      const usualMs = durations.length > 0 ? median(durations) : null;
      const scannedCount = scans.length;
      const learning = past.length > 0 && Object.keys(data.runs).length < past.length
        ? `learning: ${Object.keys(data.runs).length} of ${past.length} past runs scanned, the rest follow on the next estimates`
        : null;

      // Warnings and learned positions from the scanned runs.
      const warnings: string[] = [];
      const learned: Positions = milestones.map(() => null);
      const rels = (k: number): number[] => scans.map(s => s.rels[k]).filter((v): v is number => v !== null);
      for (let k = 0; k < milestones.length; k++) {
        const found = rels(k);
        const label = `milestone ${k + 1} ("${brief(milestones[k]!.pattern, 40)}")`;
        if (scannedCount > 0 && found.length === 0) {
          warnings.push(`${label} never matched in the last ${scannedCount} usable runs (compare the pattern with a log: orch job ${ctx.job.id} logs)`);
        } else if (scannedCount > 0 && found.length * 2 < scannedCount) {
          warnings.push(`${label} matched in only ${found.length} of the last ${scannedCount} usable runs, so it is not used`);
        } else if (found.length > 0) {
          learned[k] = median([...found].sort((a, b) => a - b));
        }
      }

      // Where each milestone falls.
      let positions: Positions;
      let mode: 'at' | 'weight' | 'learned';
      if (milestones.every(m => m.at !== undefined)) {
        mode = 'at';
        positions = milestones.map(m => m.at!);
      } else if (milestones.every(m => m.weight !== undefined)) {
        mode = 'weight';
        const total = milestones.reduce((a, m) => a + m.weight!, 0);
        let acc = 0;
        positions = milestones.map(m => (acc += m.weight!) / total);
      } else {
        mode = 'learned';
        if (scannedCount < MIN_LEARN_RUNS) {
          return none(
            `needs ${MIN_LEARN_RUNS} usable runs to learn where the milestones fall, has ${scannedCount}${learning ? ` (${learning})` : ''}; `
            + 'to estimate from the first run, put "at" on every milestone (the expected fraction of the run) or "weight" on every milestone',
            { usableRuns: scannedCount });
        }
        let top = 0;
        positions = learned.map(v => (v === null ? null : (top = Math.max(top, v))));
      }
      const known = positions.filter((v): v is number => v !== null);
      if (known.length === 0) {
        return none(`none of the milestones could be placed in the run: ${warnings.join('; ')}; give "at" on every milestone or fix the patterns`);
      }

      // The current run.
      const reader = ctx.logs.currentRun();
      const got = reader.readFrom(0);
      const hits = firstMatches(matchers, got.lines);
      if (hits === null) {
        return slow();
      }
      let L = -1;
      for (let k = 0; k < milestones.length; k++) {
        if (hits[k]! >= 0 && positions[k] !== null && (L < 0 || positions[k]! >= positions[L]!)) {
          L = k;
        }
      }

      const elapsedMs = Math.max(0, nowMs - startMs);
      const atL = L >= 0 ? positions[L]! : 0;
      const tL = L >= 0 ? Math.max(0, got.lines[hits[L]!]!.ts.getTime() - startMs) : 0;
      let N = -1;
      for (let k = L + 1; k < milestones.length; k++) {
        if (positions[k] !== null) {
          N = k;
          break;
        }
      }
      const atN = N >= 0 ? positions[N]! : 1;

      const notes: string[] = [];
      if (usualMs !== null && usualMs < SHORT_RUN_MS) {
        notes.push('note: runs last under 10 s: log timestamps have a 1 s resolution, so the estimate is coarse');
      }
      if (got.truncated) {
        notes.push('note: the log of this run is larger than the read limit, only its first part is read');
      }
      const tail = (): string => [...warnings.map(w => `warning: ${w}`), ...notes, ...(learning ? [learning] : [])].join('; ');
      const withTail = (head: string): string => [head, tail()].filter(s => s !== '').join('; ');
      const detailBase = { mode, positions: positions.map(p => (p === null ? null : round4(p))), warnings, usableRuns: scannedCount };

      // Expected total duration: the pace at the last milestone, else the usual duration.
      let expectedMs: number | null = null;
      let basis: 'pace' | 'usual' | null = null;
      if (L >= 0 && tL >= MIN_PACE_MS && atL > 0) {
        expectedMs = tL / atL;
        basis = 'pace';
      } else if (usualMs !== null) {
        expectedMs = usualMs;
        basis = 'usual';
      }

      if (L >= 0 && atL >= 1) {
        return {
          strategyId: 'log-declared', progress: 0.99, etaAt: null, confidence: 'medium', confidenceScore: 0.6,
          reason: withTail(`last milestone reached ("${brief(milestones[L]!.pattern, 40)}"): the run should finish any moment`),
          serverNow: now.toISOString(), detail: { ...detailBase, overdue: true, reached: L + 1 },
        };
      }

      if (expectedMs === null) {
        const first = positions.findIndex(p => p !== null);
        return {
          strategyId: 'log-declared', progress: 0, etaAt: null, confidence: 'low', confidenceScore: 0.3,
          reason: withTail(`waiting for the first milestone ("${brief(milestones[first]!.pattern, 40)}"); no end yet (it needs one milestone reached, or one completed run to compare with)`),
          serverNow: now.toISOString(), detail: { ...detailBase, etaUnknown: true, reached: 0 },
        };
      }

      const upper = Math.min(0.99, atL + (atN - atL) * HOLD);
      let progress = Math.max(atL, Math.min(elapsedMs / expectedMs, upper));
      let endMs = startMs + expectedMs;
      let overdue = false;
      if (elapsedMs >= expectedMs) {
        overdue = true;
        progress = upper;
      } else if (elapsedMs / expectedMs > upper) {
        endMs = startMs + elapsedMs / upper;
        progress = upper;
      }

      // Confidence.
      let base: number;
      if (mode === 'learned') {
        const found = L >= 0 ? rels(L).sort((a, b) => a - b) : [];
        const iqr = found.length >= 2 ? quantile(found, 0.75) - quantile(found, 0.25) : 0.2;
        base = Math.min(0.95, Math.max(0.3, 0.95 - 2 * iqr));
        if (scannedCount < 5) {
          base = Math.min(base, 0.45);
        }
      } else if (usualMs !== null && usualMs > 0) {
        base = 0.5 + 0.4 * (1 - Math.min(1, Math.abs(expectedMs - usualMs) / usualMs));
      } else {
        base = 0.45;
      }
      if (L < 0) {
        base *= 0.6;
      }
      if (usualMs !== null && usualMs < SHORT_RUN_MS) {
        base = Math.min(base, 0.4);
      }

      const where = L >= 0
        ? `milestone ${L + 1} of ${milestones.length} reached ("${brief(milestones[L]!.pattern, 40)}")${N >= 0 ? `, next expected at ${Math.round(atN * 100)} %` : ''}`
        : `waiting for the first milestone ("${brief(milestones[positions.findIndex(p => p !== null)]!.pattern, 40)}")`;
      const how = basis === 'pace' ? 'the pace to that milestone' : 'the usual duration of the job';
      const head = overdue
        ? `${where}; longer than the milestones predicted (expected ${formatDuration(expectedMs)} from ${how})`
        : `${where}; end from ${how}`;

      return {
        strategyId: 'log-declared',
        progress: clamp01(progress),
        etaAt: overdue ? null : new Date(endMs).toISOString(),
        confidence: levelOfScore(base),
        confidenceScore: base,
        reason: withTail(head),
        serverNow: now.toISOString(),
        detail: { ...detailBase, reached: L + 1, expectedMs, basis, ...(overdue ? { overdue: true } : {}) },
      };
    },
  };
}

export const logDeclaredStrategy = createLogDeclaredStrategy();
