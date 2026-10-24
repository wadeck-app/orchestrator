import fs from 'node:fs';
import path from 'node:path';
import { agoText, brief, freshness, levelOfScore, medianGapMs, noEstimate, projectEnd, type Sample } from './estimate-utils.js';
import { HISTORY_MIN_RUNS, median, usableDurations } from './history-strategy.js';
import type { ProgressContext, ProgressEstimate, ProgressStrategy } from './types.js';

/**
 * `declared`: the job says how far it is. Two channels, both opt-in by the job itself (orch only reads what the
 * job volunteers):
 *   - a log line  `##orch-progress <0..100>[ <message>]`  (and `##orch-progress reset` to start a new phase);
 *   - a JSON file `{ "progress": 0..100, "message"?: "..." }` named in options.file, stamped with its mtime.
 */

const TAG = '##orch-progress';
/** The part of the log looked at: the newest reports are at the end. */
const TAIL_BYTES = 256 * 1024;
/** Reports of the current phase the rate is computed over. */
const WINDOW = 8;
const FILE_MAX_BYTES = 64 * 1024;
const REPORT_RE = /^##orch-progress(?:[ \t]+(reset|\d+(?:\.\d+)?)(?:[ \t]+(.*))?)?[ \t]*$/;

interface Report {
  t: number;
  /** 0..100, or 'reset'. */
  value: number | 'reset';
  message?: string;
}

interface Collected {
  reports: Report[];
  malformed: number;
  /** Why the file gave nothing, when it was asked for. */
  fileProblem?: string;
}

function resolveFile(ctx: ProgressContext, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(ctx.job.cwd ?? path.join(ctx.configDir, 'tmp', ctx.job.id), file);
}

function readFileReport(ctx: ProgressContext, file: string, startMs: number): { report?: Report; problem?: string } {
  const full = resolveFile(ctx, file);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { problem: `the progress file ${full} does not exist (the job writes it with {"progress": 0-100})` };
    }
    // violations-suppress: ts/no-err-message-direct instanceof-guarded accessor
    return { problem: `the progress file ${full} cannot be read: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (stat.mtimeMs < startMs - 2000) {
    return { problem: `the progress file ${full} is older than this run (it was last written ${agoText(startMs - stat.mtimeMs)} before the run started), so it is the previous run's; the job must rewrite it` };
  }
  if (stat.size > FILE_MAX_BYTES) {
    return { problem: `the progress file ${full} is ${stat.size} bytes, at most ${FILE_MAX_BYTES} are read; it should hold only {"progress", "message"}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return { problem: `the progress file ${full} is not valid JSON (expected {"progress": 0-100, "message": "..."})` };
  }
  const p = (parsed as { progress?: unknown } | null)?.progress;
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
    return { problem: `in the progress file ${full}, progress must be a number from 0 to 100, got ${JSON.stringify(p) ?? 'nothing'}` };
  }
  const message = (parsed as { message?: unknown }).message;
  return { report: { t: stat.mtimeMs, value: p, ...(typeof message === 'string' ? { message } : {}) } };
}

function collect(ctx: ProgressContext, file: string | undefined, startMs: number): Collected {
  const out: Collected = { reports: [], malformed: 0 };
  for (const line of ctx.logs.currentRun().tail(TAIL_BYTES)) {
    const text = line.text.startsWith('[stderr] ') ? line.text.slice('[stderr] '.length) : line.text;
    if (!text.startsWith(TAG)) {
      continue;
    }
    const m = REPORT_RE.exec(text);
    if (!m || m[1] === undefined) {
      out.malformed++;
    } else if (m[1] === 'reset') {
      out.reports.push({ t: line.ts.getTime(), value: 'reset' });
    } else {
      const v = Number(m[1]);
      if (v > 100) {
        out.malformed++;
      } else {
        out.reports.push({ t: line.ts.getTime(), value: v, ...(m[2] ? { message: m[2] } : {}) });
      }
    }
  }
  if (file !== undefined) {
    const r = readFileReport(ctx, file, startMs);
    if (r.report) {
      out.reports.push(r.report);
    } else {
      out.fileProblem = r.problem;
    }
  }
  out.reports.sort((a, b) => a.t - b.t);
  return out;
}

const METHOD_TEXT = {
  'rate': (n: number) => `the rate of the last ${n} report(s)`,
  'history': () => 'the usual duration of the job (the reports are uneven)',
  'since-start': () => 'the pace since the start (a rate needs 2 steady reports)',
  'none': () => 'nothing yet (the job reports 0 %)',
} as const;

export const declaredStrategy: ProgressStrategy = {
  id: 'declared',
  version: 1,

  validateOptions(raw) {
    if (raw === undefined) {
      return { ok: true, value: undefined };
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return { ok: false, error: 'options must be an object like {"file": "progress.json"}, or absent to read the log convention only' };
    }
    for (const key of Object.keys(raw)) {
      if (key !== 'file') {
        return { ok: false, error: `unknown option "${key}" (accepted: file)` };
      }
    }
    const file = (raw as { file?: unknown }).file;
    if (file !== undefined && (typeof file !== 'string' || file.trim() === '' || file.length > 500 || file.includes('\0'))) {
      return { ok: false, error: '"file" must be a non-empty string path (at most 500 characters), absolute or relative to the job\'s working directory' };
    }
    return { ok: true, value: file === undefined ? {} : { file } };
  },

  estimate(ctx): ProgressEstimate {
    const now = ctx.now();
    const nowMs = now.getTime();
    const startMs = Date.parse(ctx.run.startedAt);
    const file = (ctx.options as { file?: string } | undefined)?.file;
    const got = collect(ctx, file, startMs);

    // Walk the reports: drops are ignored, a reset starts a new phase.
    let last = -1;
    let ignoredDrops = 0;
    let resets = 0;
    let phase: Array<{ t: number; v: number; message?: string }> = [];
    for (const r of got.reports) {
      if (r.value === 'reset') {
        resets++;
        last = -1;
        phase = [];
      } else if (r.value < last) {
        ignoredDrops++;
      } else {
        last = r.value;
        phase.push({ t: r.t, v: r.value, ...(r.message !== undefined ? { message: r.message } : {}) });
      }
    }

    if (phase.length === 0) {
      const sources = [`no "${TAG} <0-100>" line in the log of this run yet`];
      if (!ctx.logs.currentRun().exists()) {
        sources[0] = `no log file for this run yet (no "${TAG} <0-100>" line can exist)`;
      }
      if (got.fileProblem) {
        sources.push(got.fileProblem);
      }
      const extras = [
        ...(got.malformed > 0 ? [`${got.malformed} malformed ${TAG} line(s) ignored (the format is "${TAG} <0-100>[ <message>]")`] : []),
        ...(resets > 0 ? ['only a reset has been reported so far'] : []),
      ];
      return noEstimate('declared', now, `${[...sources, ...extras].join('; ')}; have the job print, for example: ${TAG} 25 reading input`,
        { malformed: got.malformed, ignoredDrops, resets });
    }

    const lastReport = phase[phase.length - 1]!;
    const samples: Sample[] = phase.slice(-WINDOW).map(p => ({ t: p.t, f: p.v / 100 }));
    const durations = usableDurations(ctx.history);
    const usualMs = durations.length >= HISTORY_MIN_RUNS ? median([...durations].sort((a, b) => a - b)) : null;
    const end = projectEnd({ startMs, samples, usualMs });

    const ageMs = Math.max(0, nowMs - lastReport.t);
    const fresh = freshness(ageMs, medianGapMs(samples, 30_000));
    const score = Math.min(1, end.base * fresh);
    const overdue = end.endMs !== null && end.endMs < nowMs;
    const progress = Math.min(1, Math.max(0, lastReport.v / 100));

    const parts = [
      `job reports ${lastReport.v} %${lastReport.message ? ` ("${brief(lastReport.message)}")` : ''}, last report ${agoText(ageMs)} ago`,
      overdue
        ? `later than the reports predicted (${METHOD_TEXT[end.method](samples.length)})`
        : `end from ${METHOD_TEXT[end.method](samples.length)}`,
    ];
    if (ignoredDrops > 0) {
      parts.push(`${ignoredDrops} report(s) below the last value ignored (send "${TAG} reset" to start over)`);
    }
    if (resets > 0) {
      parts.push(`restarted ${resets} time(s)`);
    }
    if (got.malformed > 0) {
      parts.push(`${got.malformed} malformed ${TAG} line(s) ignored`);
    }
    if (got.fileProblem) {
      parts.push(got.fileProblem);
    }

    return {
      strategyId: 'declared',
      progress,
      etaAt: end.endMs !== null && !overdue ? new Date(end.endMs).toISOString() : null,
      confidence: levelOfScore(score),
      confidenceScore: score,
      reason: parts.join('; '),
      serverNow: now.toISOString(),
      detail: {
        method: end.method, value: lastReport.v, reports: phase.length, lastReportAt: new Date(lastReport.t).toISOString(),
        ignoredDrops, resets, malformed: got.malformed,
        ...(lastReport.message !== undefined ? { message: lastReport.message } : {}),
        ...(overdue ? { overdue: true } : {}),
        ...(end.endMs === null ? { etaUnknown: true } : {}),
      },
    };
  },
};
