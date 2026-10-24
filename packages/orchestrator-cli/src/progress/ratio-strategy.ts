import { agoText, freshness, levelOfScore, medianGapMs, noEstimate, projectEnd, type Sample } from './estimate-utils.js';
import { HISTORY_MIN_RUNS, median, usableDurations } from './history-strategy.js';
import { DEFAULT_MATCH_BUDGET_MS, compilePattern, matcherFor, type Matcher } from './safe-regex.js';
import type { ProgressEstimate, ProgressStrategy } from './types.js';

/**
 * `ratio`: a counter the job prints, found with a user pattern that has 1 or 2 capture groups:
 *   "(\d+)/(\d+)"  -> done/total          "(\d+)%"  -> percent
 * Explicit only: orch cannot know which pattern is a counter, so `auto` never picks it.
 */

const TAIL_BYTES = 256 * 1024;
/** Lines of the tail the pattern is run on, newest last. */
const MAX_LINES = 4000;
const DEFAULT_WINDOW = 8;

export interface RatioDeps {
  /** Test seam: the matcher for a compiled pattern. */
  matcherFor?: (regex: RegExp) => Matcher;
}

interface RatioOptions {
  pattern: string;
  window: number;
}

function asOptions(raw: unknown): { ok: true; value: RatioOptions } | { ok: false; error: string } {
  if (raw === undefined) {
    return { ok: false, error: 'needs options like {"pattern": "(\\\\d+)/(\\\\d+)"} (done/total) or {"pattern": "(\\\\d+)%"} (percent): the pattern finds the counter in the job\'s log' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'options must be an object like {"pattern": "(\\\\d+)/(\\\\d+)", "window": 8}' };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'pattern' && key !== 'window') {
      return { ok: false, error: `unknown option "${key}" (accepted: pattern, window)` };
    }
  }
  const { pattern, window } = raw as { pattern?: unknown; window?: unknown };
  if (pattern === undefined) {
    return { ok: false, error: '"pattern" is required: a regular expression with 1 or 2 capture groups, for example "(\\\\d+)/(\\\\d+)"' };
  }
  const compiled = compilePattern(pattern, { groups: [1, 2] });
  if (!compiled.ok) {
    return { ok: false, error: compiled.error };
  }
  if (window !== undefined && !(Number.isInteger(window) && (window as number) >= 2 && (window as number) <= 50)) {
    return { ok: false, error: '"window" must be an integer from 2 to 50 (how many recent counter values the rate is computed over)' };
  }
  return { ok: true, value: { pattern: pattern as string, window: (window as number | undefined) ?? DEFAULT_WINDOW } };
}

export function createRatioStrategy(deps: RatioDeps = {}): ProgressStrategy {
  const matcherOf = deps.matcherFor ?? matcherFor;
  return {
    id: 'ratio',
    version: 1,

    validateOptions: asOptions,

    estimate(ctx): ProgressEstimate {
      const now = ctx.now();
      const nowMs = now.getTime();
      const startMs = Date.parse(ctx.run.startedAt);
      const checked = asOptions(ctx.options);
      if (!checked.ok) {
        return noEstimate('ratio', now, `the options of the ratio strategy are not usable: ${checked.error}; fix: orch edit ${ctx.job.id} --progress ratio --progress-options '{"pattern": "(\\\\d+)/(\\\\d+)"}'`);
      }
      const { pattern, window } = checked.value;
      const regex = compilePattern(pattern, { groups: [1, 2] });
      if (!regex.ok) {
        return noEstimate('ratio', now, regex.error);
      }
      const shown = `/${regex.regex.source}/`;

      const reader = ctx.logs.currentRun();
      const lines = reader.tail(TAIL_BYTES).slice(-MAX_LINES);
      const batch = matcherOf(regex.regex).matchLines(lines.map(l => l.text));
      if (batch.timedOut) {
        return noEstimate('ratio', now,
          `the pattern ${shown} exceeded the ${DEFAULT_MATCH_BUDGET_MS} ms match budget on this log; simplify the pattern (anchor it with ^, avoid nested repetition) with: orch edit ${ctx.job.id} --progress ratio --progress-options ...`);
      }

      let phase: Sample[] = [];
      let resets = 0;
      let malformed = 0;
      let lastText = '';
      for (let i = 0; i < lines.length; i++) {
        const m = batch.matches[i];
        if (!m) {
          continue;
        }
        const a = Number.parseFloat(m[1] ?? '');
        let f: number;
        if (m[2] !== undefined) {
          const b = Number.parseFloat(m[2]);
          if (!(b > 0) || !(a >= 0) || a > b) {
            malformed++;
            continue;
          }
          f = a / b;
        } else {
          if (!(a >= 0) || a > 100) {
            malformed++;
            continue;
          }
          f = a / 100;
        }
        const prev = phase[phase.length - 1];
        if (prev && f < prev.f - 1e-9) {
          resets++;
          phase = [];
        }
        phase.push({ t: lines[i]!.ts.getTime(), f });
        lastText = m[2] !== undefined ? `${m[1]}/${m[2]}` : `${m[1]} %`;
      }

      if (phase.length === 0) {
        const where = !reader.exists()
          ? 'no log file for this run yet'
          : `no log line matched ${shown} in this run yet (the last ${Math.min(lines.length, MAX_LINES)} lines were checked)`;
        const ignored = malformed > 0 ? `; ${malformed} match(es) ignored (value above its total, or a zero total)` : '';
        return noEstimate('ratio', now, `${where}${ignored}; compare the pattern with the log: orch job ${ctx.job.id} logs`, { malformed, resets });
      }

      const samples = phase.slice(-window);
      const last = samples[samples.length - 1]!;
      const durations = usableDurations(ctx.history);
      const usualMs = durations.length >= HISTORY_MIN_RUNS ? median([...durations].sort((a, b) => a - b)) : null;
      const end = projectEnd({ startMs, samples, usualMs });
      const ageMs = Math.max(0, nowMs - last.t);
      const score = Math.min(1, end.base * freshness(ageMs, medianGapMs(samples, 30_000)));
      const overdue = end.endMs !== null && end.endMs < nowMs;
      const method = {
        'rate': `the rate of the last ${samples.length} counter value(s)`,
        'history': 'the usual duration of the job (the counter is uneven)',
        'since-start': 'the pace since the start (a rate needs 2 distinct counter values)',
        'none': 'nothing yet (the counter is at 0)',
      }[end.method];

      const parts = [
        `counter at ${lastText} (${Math.round(last.f * 1000) / 10} %), last update ${agoText(ageMs)} ago`,
        overdue ? `later than the counter predicted (${method})` : `end from ${method}`,
      ];
      if (resets > 0) {
        parts.push(`counter restarted ${resets} time(s) (now in phase ${resets + 1})`);
      }
      if (malformed > 0) {
        parts.push(`${malformed} match(es) ignored (value above its total, or a zero total)`);
      }

      return {
        strategyId: 'ratio',
        progress: Math.min(1, Math.max(0, last.f)),
        etaAt: end.endMs !== null && !overdue ? new Date(end.endMs).toISOString() : null,
        confidence: levelOfScore(score),
        confidenceScore: score,
        reason: parts.join('; '),
        serverNow: now.toISOString(),
        detail: {
          method: end.method, counter: lastText, samples: samples.length, resets, malformed, lastUpdateAt: new Date(last.t).toISOString(),
          ...(overdue ? { overdue: true } : {}),
          ...(end.endMs === null ? { etaUnknown: true } : {}),
        },
      };
    },
  };
}

export const ratioStrategy = createRatioStrategy();
