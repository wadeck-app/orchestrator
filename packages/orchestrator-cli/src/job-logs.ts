import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';

/**
 * `orch job-logs <id>`: a job's run log as plain text, a snapshot or followed.
 *
 * Reads the per-run files RunLogger writes (logs/jobs/<id>/<id>-<YYYY-MM-DDTHH-MM-SS>.log), the same files
 * `orch logs --job` and the dashboard read; the run metadata (exit code, running or not, trigger) comes from the
 * daemon's run history, with the [job:started] / [job:finished] markers of the file as the fallback.
 *
 * Returns the process exit code instead of exiting, so the caller decides how to leave.
 */

export const JOB_LOGS_USAGE = 'Usage: orch job-logs <id> [-f|--follow] [-n|--tail <N>] [--run <which>] [--list-runs] [--json]';

export interface JobLogsOptions {
  jobId: string;
  follow: boolean;
  tail: number | undefined;
  run: string;
  listRuns: boolean;
  json: boolean;
}

export type ParsedJobLogsArgs = { ok: true; options: JobLogsOptions } | { ok: false; error: string };

const RUN_WORDS = 'latest, previous, a number from 1 (1 = latest, 2 = the run before), or a start time as printed by --list-runs';

/** Parses the arguments after `job-logs`. Every refusal says what is accepted. */
export function parseJobLogsArgs(args: string[], json: boolean): ParsedJobLogsArgs {
  const options: JobLogsOptions = { jobId: '', follow: false, tail: undefined, run: 'latest', listRuns: false, json };
  let runGiven = false;
  const fail = (error: string): ParsedJobLogsArgs => ({ ok: false, error: `${error}\n${JOB_LOGS_USAGE}` });
  const valueOf = (i: number, name: string): string | ParsedJobLogsArgs => {
    const v = args[i + 1];
    // A negative number is a value (and then a bad one, with its own message); another flag is not.
    if (v === undefined || /^-[a-z-]/i.test(v)) {
      return fail(`${name} needs a value.`);
    }
    return v;
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-f' || a === '--follow') {
      options.follow = true;
    } else if (a === '--list-runs') {
      options.listRuns = true;
    } else if (a === '--json') {
      options.json = true;
    } else if (a === '-n' || a === '--tail') {
      const v = valueOf(i, a);
      if (typeof v !== 'string') {
        return v;
      }
      if (!/^\d+$/.test(v) || Number(v) < 1 || !Number.isSafeInteger(Number(v))) {
        return fail(`${a} must be a whole number of 1 or more (the number of last lines to show); got "${v}".`);
      }
      options.tail = Number(v);
      i++;
    } else if (a === '--run') {
      const v = valueOf(i, a);
      if (typeof v !== 'string') {
        return v;
      }
      if (parseRunSelector(v) === null) {
        return fail(`--run must be one of: ${RUN_WORDS}; got "${v}".`);
      }
      options.run = v;
      runGiven = true;
      i++;
    } else if (a.startsWith('-')) {
      return fail(`Unknown flag "${a}". Accepted: -f/--follow, -n/--tail <N>, --run <which>, --list-runs, --json.`);
    } else if (options.jobId === '') {
      options.jobId = a;
    } else {
      return fail(`Unexpected argument "${a}": only one job id is accepted (already got "${options.jobId}").`);
    }
  }

  if (options.jobId === '') {
    return fail('Missing job id. See the ids with: orch list');
  }
  if (options.listRuns) {
    const clash = options.follow ? '-f/--follow' : options.tail !== undefined ? '-n/--tail' : runGiven ? '--run' : null;
    if (clash !== null) {
      return fail(`--list-runs lists the runs; it cannot be combined with ${clash}. Run them separately.`);
    }
  }
  return { ok: true, options };
}

type RunSelector = { kind: 'index'; n: number } | { kind: 'time'; name: string };

/** `latest`, `previous`, a number from 1, or a start time in any of the spellings the listing and the file names use. */
function parseRunSelector(raw: string): RunSelector | null {
  const v = raw.trim();
  if (v === 'latest') {
    return { kind: 'index', n: 1 };
  }
  if (v === 'previous') {
    return { kind: 'index', n: 2 };
  }
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    return n >= 1 && Number.isSafeInteger(n) ? { kind: 'index', n } : null;
  }
  const m = v.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2})[:-](\d{2})[:-](\d{2})(?:\.\d+)?Z?$/);
  return m ? { kind: 'time', name: `${m[1]}T${m[2]}-${m[3]}-${m[4]}` } : null;
}

export interface RuntimeRecord {
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  triggeredBy?: { kind?: string };
}

export interface JobLogsDeps {
  send: (command: string, payload?: unknown) => Promise<unknown>;
  configDir: string;
  /** How often a followed file is read. */
  pollMs?: number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface RunFile {
  /** `YYYY-MM-DDTHH-MM-SS`, the part of the file name after `<id>-`. */
  name: string;
  file: string;
}

type RunStatus = 'running' | 'finished' | 'unknown';

interface RunInfo extends RunFile {
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
  trigger: string | null;
}

function compactStart(startedAt: string): string {
  return startedAt.replace(/:/g, '-').slice(0, 19);
}

function displayStart(name: string): string {
  return `${name.slice(0, 10)} ${name.slice(11).replace(/-/g, ':')}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The retained runs of a job, newest first. Legacy one-file-per-day logs are not runs and are not listed. */
function listRunFiles(configDir: string, jobId: string): RunFile[] {
  const dir = path.join(configDir, 'logs', 'jobs', jobId);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const pat = new RegExp(`^${escapeRegExp(jobId)}-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.log$`);
  const runs: RunFile[] = [];
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(pat);
    if (m) {
      runs.push({ name: m[1]!, file: path.join(dir, f) });
    }
  }
  return runs.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
}

const FINISH_RE = /\[job:(?:finished|skipped)\] exitCode=(-?\d+)(?: duration=([\d.]+)s)?/;
const START_RE = /\[job:started\] .*?triggeredBy=(\w+)/;

function describeRun(run: RunFile, history: Map<string, RuntimeRecord>): RunInfo {
  const entry = history.get(run.name);
  let text = '';
  try { text = fs.readFileSync(run.file, 'utf8'); } catch { /* the file may be pruned between listing and reading */ }
  const fin = text.match(FINISH_RE);
  const trigger = entry?.triggeredBy?.kind ?? text.match(START_RE)?.[1] ?? null;
  if (entry) {
    const finished = entry.finishedAt !== undefined || entry.exitCode !== null;
    const end = entry.finishedAt !== undefined ? Date.parse(entry.finishedAt) : Date.now();
    const start = Date.parse(entry.startedAt);
    return {
      ...run,
      status: finished ? 'finished' : 'running',
      exitCode: finished ? entry.exitCode : null,
      durationMs: Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start),
      trigger,
    };
  }
  if (fin) {
    return { ...run, status: 'finished', exitCode: Number(fin[1]), durationMs: fin[2] !== undefined ? Math.round(Number(fin[2]) * 1000) : null, trigger };
  }
  return { ...run, status: 'unknown', exitCode: null, durationMs: null, trigger };
}

function formatDuration(ms: number | null): string {
  if (ms === null) {
    return '-';
  }
  const s = Math.round(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m${String(s % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

function statusCell(r: RunInfo): string {
  return r.status === 'running' ? 'running' : r.status === 'unknown' ? 'unknown' : String(r.exitCode);
}

interface LogLine { t: string | null; text: string }

function toLogLine(line: string): LogLine {
  const m = line.match(/^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] ?(.*)$/);
  return m ? { t: m[1]!, text: m[2]! } : { t: null, text: line };
}

/** Lines of a file's content; a trailing newline does not make an empty last line. */
function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

export async function runJobLogs(options: JobLogsOptions, deps: JobLogsDeps): Promise<number> {
  const out = deps.stdout ?? ((t: string) => { process.stdout.write(t); });
  const err = deps.stderr ?? ((t: string) => { process.stderr.write(t); });
  const pollMs = deps.pollMs ?? 250;
  const { jobId } = options;

  const job = await deps.send('get-job', { id: jobId });
  if (!job) {
    err(`Job not found: "${jobId}". Run \`orch list\` to see the available job ids.\n`);
    return 1;
  }

  const files = listRunFiles(deps.configDir, jobId);
  if (files.length === 0) {
    err(`Job "${jobId}" has no log yet: it has not run since logs were last cleaned. Run it with: orch trigger ${jobId}\n`);
    return 1;
  }

  const readHistory = async (): Promise<Map<string, RuntimeRecord>> => {
    const all = await deps.send('list-state') as Record<string, RuntimeRecord[]> | null;
    const map = new Map<string, RuntimeRecord>();
    for (const e of all?.[jobId] ?? []) {
      map.set(compactStart(e.startedAt), e);
    }
    return map;
  };
  const history = await readHistory();

  if (options.listRuns) {
    const runs = files.map(f => describeRun(f, history));
    if (options.json) {
      out(JSON.stringify(runs.map((r, i) => ({
        run: i + 1,
        startedAt: displayStart(r.name),
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        trigger: r.trigger,
      }))) + '\n');
      return 0;
    }
    const rows = runs.map((r, i) => [displayStart(r.name), statusCell(r), formatDuration(r.durationMs), r.trigger ?? '-', `--run ${i + 1}`]);
    const header = ['START (UTC)', 'EXIT', 'DURATION', 'TRIGGER', 'READ WITH'];
    const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c]!.length)));
    const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
    out(`${[fmt(header), ...rows.map(fmt)].join('\n')}\n`);
    return 0;
  }

  // The selector was validated by parseJobLogsArgs.
  const selector = parseRunSelector(options.run)!;
  const target = selector.kind === 'index' ? files[selector.n - 1] : files.find(f => f.name === selector.name);
  if (!target) {
    const have = selector.kind === 'index'
      ? `the job has ${files.length} retained run${files.length === 1 ? '' : 's'}`
      : `no run started at ${displayStart(selector.name)}`;
    err(`No such run for "${jobId}": --run ${options.run} (${have}). See the runs with: orch job-logs ${jobId} --list-runs\n`);
    return 1;
  }
  const info = describeRun(target, history);
  const isLatest = target === files[0];

  let content: string;
  try {
    content = fs.readFileSync(target.file, 'utf8');
  } catch (e) {
    err(`Cannot read ${target.file}: ${getErrorMessage(e)}. Check that the file exists and is readable.\n`);
    return 1;
  }

  const following = options.follow && info.status === 'running';
  // While following, an unterminated last line may still be growing: hold it for the next read.
  let pending = '';
  let body = content;
  if (following) {
    const cut = content.lastIndexOf('\n');
    pending = content.slice(cut + 1);
    body = content.slice(0, cut + 1);
  }
  const all = splitLines(body);
  const shown = options.tail !== undefined && all.length > options.tail ? all.slice(all.length - options.tail) : all;
  const cutCount = all.length - shown.length;
  if (cutCount > 0) {
    err(`[orch] ${cutCount} earlier line${cutCount === 1 ? '' : 's'} not shown (-n ${options.tail}). Drop -n for the whole run.\n`);
  }

  const emitLine = (line: string): void => {
    out(options.json ? `${JSON.stringify(toLogLine(line))}\n` : `${line}\n`);
  };

  if (!following) {
    if (options.json && !options.follow) {
      out(`${JSON.stringify(shown.map(toLogLine))}\n`);
    } else {
      shown.forEach(emitLine);
    }
    if (options.follow) {
      err(isLatest
        ? 'the job is not running; showing the last run\n'
        : `run ${displayStart(target.name)} has ended; showing it (not following)\n`);
    }
    return 0;
  }

  // --- follow a running run ---
  shown.forEach(emitLine);
  let ended: { exitCode: number | null } | null = null;
  const scan = (lines: string[]): void => {
    for (const l of lines) {
      const m = l.match(FINISH_RE);
      if (m && ended === null) {
        ended = { exitCode: Number(m[1]) };
      }
    }
  };
  scan(all);

  let offset = Buffer.byteLength(content.slice(0, content.length - pending.length), 'utf8');
  const drain = (): void => {
    const size = fs.statSync(target.file).size;
    if (size <= offset) {
      return;
    }
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(target.file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const chunk = pending + buf.toString('utf8');
    const cut = chunk.lastIndexOf('\n');
    pending = chunk.slice(cut + 1);
    const lines = splitLines(chunk.slice(0, cut + 1));
    lines.forEach(emitLine);
    scan(lines);
  };

  let interrupted = false;
  let wake: (() => void) | null = null;
  const onSigint = (): void => { interrupted = true; wake?.(); };
  process.on('SIGINT', onSigint);
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => { clearTimeout(timer); resolve(); };
  });

  const historyEveryMs = Math.max(pollMs * 8, pollMs);
  let lastHistoryCheck = Date.now();
  try {
    while (ended === null && !interrupted) {
      await sleep(pollMs);
      if (interrupted) {
        break;
      }
      drain();
      if (ended === null && Date.now() - lastHistoryCheck >= historyEveryMs) {
        lastHistoryCheck = Date.now();
        const entry = (await readHistory()).get(target.name);
        if (entry && (entry.finishedAt !== undefined || entry.exitCode !== null)) {
          drain();
          if (ended === null) {
            ended = { exitCode: entry.exitCode };
          }
        }
      }
    }
  } catch (e) {
    err(`Lost track of the run while following (${getErrorMessage(e)}). The run may still be going: read it again with: orch job-logs ${jobId} -f\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }

  const final = ended as { exitCode: number | null } | null;
  if (final !== null) {
    const code = final.exitCode === null ? 'unknown' : String(final.exitCode);
    if (options.json) {
      out(`${JSON.stringify({ event: 'run-ended', exitCode: final.exitCode })}\n`);
    } else {
      out(`[orch] run ended with exit code ${code}\n`);
    }
  }
  return 0;
}
