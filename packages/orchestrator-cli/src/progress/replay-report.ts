import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from '../fsUtil.js';
import type { Job, RuntimeEntry } from '../types.js';
import { createLogCorpus } from './log-corpus.js';
import { PROGRESS_STRATEGY_IDS, STRATEGIES } from './registry.js';
import { DEFAULT_SAMPLE_EVERY_PERCENT, memoryStore, replayJob, type ReplayMetrics } from './replay.js';
import type { ProgressStrategy } from './types.js';

/*
 * `orch progress replay <jobId>`: the report around replayJob (replay.ts). It reads the job and its run history
 * from registry.json and state.json and the logs from the config dir, read-only and without the daemon, so it
 * also works on a copy of a config dir.
 */

/** Replayed when --strategy is not given: the ones that need nothing configured. The job's own strategy is added. */
const DEFAULT_REPLAY_IDS = ['declared', 'log-learned', 'history'] as const;
/** Fewer usable runs than this and the first one has nothing to learn from. */
export const REPLAY_MIN_RUNS = 3;
const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

export interface StrategyReport {
  id: string;
  /** Set when the strategy cannot be replayed for this job (it needs options); then there are no metrics. */
  unavailable?: string;
  metrics: ReplayMetrics;
  errors: string[];
}

export interface ReplayReport {
  jobId: string;
  /** Usable runs replayed. */
  runs: number;
  sampleEveryPercent: number;
  strategies: StrategyReport[];
  /** The strategy with the lowest mean ETA error (as a share of the run duration), or null. */
  best: string | null;
  verdict: string;
}

const EMPTY_METRICS: ReplayMetrics = {
  samples: 0, estimated: 0, coverage: 0, maeSec: null, maePct: null,
  byFraction: { 25: { maeSec: null, maePct: null }, 50: { maeSec: null, maePct: null }, 75: { maeSec: null, maePct: null } },
  monotonicityViolations: 0, etaFlips: 0,
};

export interface ReplayInputs {
  job: Job;
  history: RuntimeEntry[];
}

function readJson(file: string, what: string, hint: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${what} (${file}): ${getErrorMessage(e)}. ${hint}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${what} (${file}) is not valid JSON: ${getErrorMessage(e)}`);
  }
}

/** The job and its run history from the files of a config dir. Writes nothing. Throws with the way out. */
export function readReplayInputs(configDir: string, jobId: string): ReplayInputs {
  const hint = `The config dir is ${configDir}; set ORCH_CONFIG_DIR to the one the daemon uses (it holds registry.json and state.json).`;
  const registry = readJson(path.join(configDir, 'registry.json'), 'the job registry', hint) as { jobs?: Job[] };
  const jobs = Array.isArray(registry.jobs) ? registry.jobs : [];
  const job = jobs.find(j => j.id === jobId);
  if (!job) {
    const ids = jobs.map(j => j.id);
    throw new Error(`No job has the id "${jobId}". ${ids.length > 0 ? `Known ids: ${ids.join(', ')}.` : 'The registry has no job.'}`);
  }
  const state = fs.existsSync(path.join(configDir, 'state.json'))
    ? readJson(path.join(configDir, 'state.json'), 'the run history', hint) as { jobs?: Record<string, unknown> }
    : { jobs: {} };
  const raw = state.jobs?.[jobId];
  const history = Array.isArray(raw) ? raw as RuntimeEntry[] : raw && typeof raw === 'object' ? [raw as RuntimeEntry] : [];
  return { job, history };
}

export interface ReplayReportInput {
  job: Job;
  history: readonly RuntimeEntry[];
  configDir: string;
  strategyId?: string;
  sampleEveryPercent?: number;
}

function optionsOf(job: Job, id: string): unknown {
  const p = job.progress;
  return p !== undefined && typeof p === 'object' && p.strategy === id ? p.options : undefined;
}

export function buildReplayReport(input: ReplayReportInput): ReplayReport {
  const { job, configDir } = input;
  const sampleEveryPercent = input.sampleEveryPercent ?? DEFAULT_SAMPLE_EVERY_PERCENT;

  let ids: string[];
  if (input.strategyId !== undefined) {
    if (!PROGRESS_STRATEGY_IDS.includes(input.strategyId)) {
      throw new Error(`unknown strategy "${input.strategyId}". Registered: ${PROGRESS_STRATEGY_IDS.join(', ')}`);
    }
    ids = [input.strategyId];
  } else {
    ids = [...DEFAULT_REPLAY_IDS];
    const own = typeof job.progress === 'string' ? job.progress : job.progress?.strategy;
    if (own !== undefined && PROGRESS_STRATEGY_IDS.includes(own) && !ids.includes(own)) {
      ids.push(own);
    }
  }

  const corpus = createLogCorpus({ configDir, jobId: job.id, history: [...input.history], currentStartedAt: FAR_FUTURE });
  const usable = corpus.pastRuns(20).length;
  const base = { jobId: job.id, sampleEveryPercent };
  if (usable < REPLAY_MIN_RUNS) {
    return {
      ...base, runs: usable, strategies: [], best: null,
      verdict: `${usable} usable run(s) retained for ${job.id}; a replay needs at least ${REPLAY_MIN_RUNS} (the first has nothing to learn from). ` +
        'Let the job run to completion with exit code 0 a few more times, then retry. Failed, killed, skipped and orphaned runs do not count.',
    };
  }

  const strategies: StrategyReport[] = [];
  const runnable: ProgressStrategy[] = [];
  const optionsById: Record<string, unknown> = {};
  for (const id of ids) {
    const strategy = STRATEGIES.find(s => s.id === id)!;
    const options = optionsOf(job, id);
    const validated = strategy.validateOptions(options);
    if (!validated.ok) {
      strategies.push({
        id, metrics: EMPTY_METRICS, errors: [],
        unavailable: `needs options (${validated.error}); set them with: orch edit ${job.id} --progress ${id} --progress-options <json-or-@file>`,
      });
      continue;
    }
    optionsById[id] = validated.value;
    runnable.push(strategy);
  }

  const result = replayJob({
    job, configDir, corpus, strategies: runnable, sampleEveryPercent, options: optionsById,
    // log-learned keys what it learned by run and never reads a newer one, so one store serves the whole replay.
    stores: { 'log-learned': memoryStore() },
  });
  for (const id of ids) {
    const r = result.strategies[id];
    if (r) {
      strategies.push({ id, metrics: r.metrics, errors: r.errors });
    }
  }
  strategies.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));

  const scored = strategies.filter(s => s.metrics.maePct !== null && s.metrics.coverage > 0);
  scored.sort((a, b) => a.metrics.maePct! - b.metrics.maePct!);
  const best = scored[0];
  const verdict = best
    ? `Best: ${best.id} (mean ETA error ${pct(best.metrics.maePct)} of the run duration, ${sec(best.metrics.maeSec)}, over ${result.runs} run(s))`
    : `No strategy produced an estimate on ${result.runs} run(s). ${strategies.some(s => s.unavailable) ? 'Some need options: see the table. ' : ''}` +
      'See why on a live run with: orch status; the reason names what is missing.';
  return { ...base, runs: result.runs, strategies, best: best?.id ?? null, verdict };
}

function pct(v: number | null): string {
  return v === null ? '-' : `${(v * 100).toFixed(1)}%`;
}

function sec(v: number | null): string {
  return v === null ? '-' : `${v.toFixed(1)} s`;
}

/** The table `orch progress replay` prints. */
export function formatReplayReport(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`Replay of ${report.jobId}: ${report.runs} usable run(s), a sample every ${report.sampleEveryPercent}% of each run (leave-one-out, no look-ahead)`);
  if (report.strategies.length === 0) {
    lines.push(report.verdict);
    return lines.join('\n');
  }
  const header = ['strategy', 'cover', 'MAE s', 'MAE %', '@25%', '@50%', '@75%', 'non-monotonic', 'flips'];
  const rows = report.strategies.map(s => s.unavailable ? [s.id, '-', '-', '-', '-', '-', '-', '-', '-'] : [
    s.id, pct(s.metrics.coverage), s.metrics.maeSec === null ? '-' : s.metrics.maeSec.toFixed(1), pct(s.metrics.maePct),
    pct(s.metrics.byFraction[25].maePct), pct(s.metrics.byFraction[50].maePct), pct(s.metrics.byFraction[75].maePct),
    String(s.metrics.monotonicityViolations), String(s.metrics.etaFlips),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)));
  const fmt = (r: string[]): string => r.map((c, i) => i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)).join('  ').trimEnd();
  lines.push(fmt(header), ...rows.map(fmt));
  for (const s of report.strategies) {
    if (s.unavailable) {
      lines.push(`${s.id}: not replayed, ${s.unavailable}`);
    }
    for (const e of s.errors) {
      lines.push(`${s.id}: error during the replay: ${e}`);
    }
  }
  lines.push(report.verdict);
  return lines.join('\n');
}

export const PROGRESS_REPLAY_USAGE = 'Usage: orch progress replay <jobId> [--strategy <id>] [--sample-every <percent>] [--json]';

export interface ReplayArgs {
  jobId: string;
  strategyId: string | undefined;
  sampleEveryPercent: number;
  json: boolean;
}

export type ParsedReplayArgs = { ok: true; args: ReplayArgs } | { ok: false; error: string };

/** The arguments after `orch progress replay`. Every refusal says what is accepted. */
export function parseReplayArgs(argv: string[], json: boolean): ParsedReplayArgs {
  const fail = (error: string): ParsedReplayArgs => ({ ok: false, error: `${error}\n${PROGRESS_REPLAY_USAGE}` });
  let jobId: string | undefined;
  let strategyId: string | undefined;
  let sampleEveryPercent = DEFAULT_SAMPLE_EVERY_PERCENT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--json') {
      json = true;
    } else if (a === '--strategy' || a === '--sample-every') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        return fail(`${a} needs a value.`);
      }
      i++;
      if (a === '--strategy') {
        if (!PROGRESS_STRATEGY_IDS.includes(v)) {
          return fail(`unknown strategy "${v}". Registered: ${PROGRESS_STRATEGY_IDS.join(', ')}`);
        }
        strategyId = v;
      } else {
        const n = Number(v);
        if (!/^\d+$/.test(v) || n < 1 || n > 50) {
          return fail(`--sample-every must be a whole number from 1 to 50 (got "${v}").`);
        }
        sampleEveryPercent = n;
      }
    } else if (a.startsWith('-')) {
      return fail(`Unknown option "${a}".`);
    } else if (jobId === undefined) {
      jobId = a;
    } else {
      return fail(`Unexpected argument "${a}".`);
    }
  }
  if (jobId === undefined) {
    return fail('Missing job id. See the ids with: orch list');
  }
  return { ok: true, args: { jobId, strategyId, sampleEveryPercent, json } };
}

/** Runs the command; returns the process exit code (0 ok, 1 no such job or unreadable files). */
export function runProgressReplay(args: ReplayArgs, configDir: string, out: (text: string) => void, err: (text: string) => void): number {
  let report: ReplayReport;
  try {
    const { job, history } = readReplayInputs(configDir, args.jobId);
    report = buildReplayReport({ job, history, configDir, strategyId: args.strategyId, sampleEveryPercent: args.sampleEveryPercent });
  } catch (e) {
    err(getErrorMessage(e));
    return 1;
  }
  out(args.json ? JSON.stringify(report, null, 2) : formatReplayReport(report));
  return 0;
}
