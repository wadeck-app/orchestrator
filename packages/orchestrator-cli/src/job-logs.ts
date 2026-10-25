import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';
import { stripAnsi } from './ansi.js';
import { systemTime, type TimeService } from './time-service.js';
import { listRunSegments, segmentPath, type RunSegment } from './log-rotation.js';

/**
 * `orch job <jobId> logs [execId]`: an execution's log as plain text, a snapshot or followed.
 *
 * Reads the per-run files RunLogger writes (logs/jobs/<id>/<id>-<YYYY-MM-DDTHH-MM-SS>.log), the same files
 * `orch logs --job` and the dashboard read; the run metadata (exit code, running or not, trigger) comes from the
 * daemon's run history, with the [job:started] / [job:finished] markers of the file as the fallback.
 *
 * Returns the process exit code instead of exiting, so the caller decides how to leave.
 */

export const JOB_LOGS_USAGE = 'Usage: orch job <jobId> logs [execId] [-f|--follow] [-n|--tail <N>] [--list] [--json] [--raw]';

export interface JobLogsOptions {
  jobId: string;
  follow: boolean;
  tail: number | undefined;
  /** `latest`, `previous`, a number from 1 or an exec id: validated by parseJobLogsArgs. */
  execId: string;
  list: boolean;
  json: boolean;
  /** Keep the escape sequences of the file (colour, cursor codes); stripped from what is printed by default. */
  raw: boolean;
}

export type ParsedJobLogsArgs = { ok: true; options: JobLogsOptions } | { ok: false; error: string };

const EXEC_ID_WORDS = 'latest, previous, a number from 1 (1 = latest, 2 = the one before), or an exec id as printed by --list (e.g. 2026-10-24T08-35-01)';

/** Parses the arguments after `orch job <jobId> logs`. Every refusal says what is accepted. */
export function parseJobLogsArgs(jobId: string, args: string[], json: boolean): ParsedJobLogsArgs {
  const options: JobLogsOptions = { jobId, follow: false, tail: undefined, execId: 'latest', list: false, json, raw: false };
  let execGiven = false;
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
    } else if (a === '--list') {
      options.list = true;
    } else if (a === '--json') {
      options.json = true;
    } else if (a === '--raw') {
      options.raw = true;
    } else if (a === '-n' || a === '--tail') {
      const v = valueOf(i, a);
      if (typeof v !== 'string') {
        return v;
      }
      if (/^\d+$/.test(v) && !Number.isSafeInteger(Number(v))) {
        return fail(`${a} is too large: "${v}" exceeds ${Number.MAX_SAFE_INTEGER}. Use a smaller number of last lines, or drop ${a} for the whole run.`);
      }
      if (!/^\d+$/.test(v) || Number(v) < 1) {
        return fail(`${a} must be a whole number of 1 or more (the number of last lines to show); got "${v}".`);
      }
      options.tail = Number(v);
      i++;
    } else if (a.startsWith('-')) {
      return fail(`Unknown flag "${a}". Accepted: -f/--follow, -n/--tail <N>, --list, --json, --raw.`);
    } else if (!execGiven) {
      if (parseExecSelector(a) === null) {
        return fail(`execId must be one of: ${EXEC_ID_WORDS}; got "${a}".`);
      }
      options.execId = a;
      execGiven = true;
    } else {
      return fail(`Unexpected argument "${a}": only one execId is accepted (already got "${options.execId}").`);
    }
  }

  if (options.list) {
    const clash = options.follow ? '-f/--follow' : options.tail !== undefined ? '-n/--tail' : execGiven ? `the execId "${options.execId}"` : null;
    if (clash !== null) {
      return fail(`--list lists the executions; it cannot be combined with ${clash}. Run them separately.`);
    }
  }
  return { ok: true, options };
}

type ExecSelector = { kind: 'index'; n: number } | { kind: 'stamp'; name: string };

/** `latest`, `previous`, a number from 1, or an exec id: the run stamp as in the file name, or `YYYY-MM-DD HH:MM:SS`. */
function parseExecSelector(raw: string): ExecSelector | null {
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
  return m ? { kind: 'stamp', name: `${m[1]}T${m[2]}-${m[3]}-${m[4]}` } : null;
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
  /** The clock of the follow loop (poll sleep and history check cadence); the real one by default. Tests drive a FakeTime. */
  time?: TimeService;
}

interface RunFile {
  /** `YYYY-MM-DDTHH-MM-SS`, the part of the file name after `<id>-`. */
  name: string;
  /** The retained segments of the run in order (log-rotation.ts); one when the log was never rotated. */
  segments: RunSegment[];
}

type RunStatus = 'running' | 'finished' | 'unknown';

interface RunInfo extends RunFile {
  status: RunStatus;
  exitCode: number | null;
  durationMs: number | null;
  trigger: string | null;
}

/** How many segments were dropped from the start of the run: the numbers are never reused, so the first kept one tells. */
function droppedSegments(run: RunFile): number {
  return run.segments[0]!.n - 1;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function readFileLines(file: string): string[] {
  try {
    return splitLines(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return []; // dropped by the rotation between the listing and the read
    }
    throw e;
  }
}

/** The lines of a file without holding it: newlines counted in chunks. A last line without a newline counts. */
function countLines(file: string): number {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw e;
  }
  try {
    const chunk = Buffer.alloc(65536);
    let count = 0;
    let lastByte = 0x0a;
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) {
        break;
      }
      for (let i = 0; i < n; i++) {
        if (chunk[i] === 0x0a) {
          count++;
        }
      }
      lastByte = chunk[n - 1]!;
    }
    return lastByte === 0x0a ? count : count + 1;
  } finally {
    fs.closeSync(fd);
  }
}

function compactStart(startedAt: string): string {
  return startedAt.replace(/:/g, '-').slice(0, 19);
}

function displayStart(name: string): string {
  return `${name.slice(0, 10)} ${name.slice(11).replace(/-/g, ':')}`;
}

/** The retained runs of a job, newest first, each with its segments. Legacy one-file-per-day logs are not runs and are not listed. */
function listRunFiles(configDir: string, jobId: string): RunFile[] {
  const runs = listRunSegments(path.join(configDir, 'logs', 'jobs', jobId), jobId);
  return [...runs.entries()].map(([name, segments]) => ({ name, segments })).reverse();
}

const FINISH_RE = /\[job:(?:finished|skipped)\] exitCode=(-?\d+)(?: duration=([\d.]+)s)?/;
const START_RE = /\[job:started\] .*?triggeredBy=(\w+)/;

function describeRun(run: RunFile, history: Map<string, RuntimeRecord>): RunInfo {
  const entry = history.get(run.name);
  // The start marker is in the first segment, the end marker in the last one.
  const readText = (seg: RunSegment): string => {
    try { return fs.readFileSync(seg.file, 'utf8'); } catch { return ''; /* pruned between listing and reading */ }
  };
  const startText = readText(run.segments[0]!);
  const endText = run.segments.length === 1 ? startText : readText(run.segments[run.segments.length - 1]!);
  const fin = endText.match(FINISH_RE);
  const trigger = entry?.triggeredBy?.kind ?? startText.match(START_RE)?.[1] ?? null;
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
  // A run the daemon recorded as ended without learning its exit code (killed with the daemon) has none to show.
  return r.status === 'running' ? 'running' : r.status === 'unknown' || r.exitCode === null ? 'unknown' : String(r.exitCode);
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

  if (options.list) {
    const runs = files.map(f => describeRun(f, history));
    if (options.json) {
      out(JSON.stringify(runs.map((r) => ({
        execId: r.name,
        startedAt: displayStart(r.name),
        status: r.status,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        trigger: r.trigger,
        segments: r.segments.length,
        droppedSegments: droppedSegments(r),
        sizeBytes: r.segments.reduce((sum, s) => sum + s.size, 0),
      }))) + '\n');
      return 0;
    }
    const rows = runs.map((r) => [
      r.name, displayStart(r.name), statusCell(r), formatDuration(r.durationMs), r.trigger ?? '-',
      droppedSegments(r) > 0 ? `${r.segments.length} (+${droppedSegments(r)} dropped)` : String(r.segments.length),
      formatSize(r.segments.reduce((sum, s) => sum + s.size, 0)),
    ]);
    const header = ['EXEC ID', 'START (UTC)', 'EXIT', 'DURATION', 'TRIGGER', 'SEGMENTS', 'SIZE'];
    const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => r[c]!.length)));
    const fmt = (cells: string[]): string => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ').trimEnd();
    out(`${[fmt(header), ...rows.map(fmt)].join('\n')}\n`);
    return 0;
  }

  // The execId was validated by parseJobLogsArgs.
  const selector = parseExecSelector(options.execId)!;
  const target = selector.kind === 'index' ? files[selector.n - 1] : files.find(f => f.name === selector.name);
  if (!target) {
    const have = selector.kind === 'index'
      ? ` (the job has ${files.length} retained execution${files.length === 1 ? '' : 's'})`
      : '';
    err(`No execution "${options.execId}" for job "${jobId}"${have}. See the executions with: orch job ${jobId} logs --list\n`);
    return 1;
  }
  const info = describeRun(target, history);
  const isLatest = target === files[0];

  // The run may be several segments (log-rotation.ts): they read as one log, in order. The newest is read first because it
  // is the one a follower goes on with; the older ones only contribute lines.
  const segments = target.segments;
  const lastSegment = segments[segments.length - 1]!;
  let raw: Buffer;
  try {
    raw = fs.readFileSync(lastSegment.file);
  } catch (e) {
    err(`Cannot read ${lastSegment.file}: ${getErrorMessage(e)}. Check that the file exists and is readable.\n`);
    return 1;
  }
  if (droppedSegments(target) > 0) {
    const d = droppedSegments(target);
    err(`[orch] ${d} earlier ${plural(d, 'segment', 'segments')} of this execution ${plural(d, 'was', 'were')} dropped by log rotation; `
      + `the log starts at segment ${segments[0]!.n} (keepSegments, see docs/daemon-config.md)\n`);
  }

  const following = options.follow && info.status === 'running';
  // While following, an unterminated last line may still be growing: hold it for the next read.
  // Held as bytes: a multibyte character may be cut by a read as well, and decoding it half would corrupt it.
  let pending: Buffer = Buffer.alloc(0);
  let body = raw.toString('utf8');
  if (following) {
    const cut = raw.lastIndexOf(0x0a);
    pending = raw.subarray(cut + 1);
    body = raw.subarray(0, cut + 1).toString('utf8');
  }
  const all = splitLines(body);
  // -n reads back from the newest segment and stops as soon as it has enough; the older ones are only counted.
  let shown = all;
  let cutCount = 0;
  if (options.tail === undefined) {
    shown = [...segments.slice(0, -1).flatMap((s) => readFileLines(s.file)), ...all];
  } else {
    shown = all.slice(Math.max(0, all.length - options.tail));
    cutCount = all.length - shown.length;
    for (let i = segments.length - 2; i >= 0; i--) {
      const room = options.tail - shown.length;
      if (room > 0) {
        const lines = readFileLines(segments[i]!.file);
        const take = lines.slice(Math.max(0, lines.length - room));
        shown = [...take, ...shown];
        cutCount += lines.length - take.length;
      } else {
        cutCount += countLines(segments[i]!.file);
      }
    }
  }
  if (cutCount > 0) {
    err(`[orch] ${cutCount} earlier line${cutCount === 1 ? '' : 's'} not shown (-n ${options.tail}). Drop -n for the whole run.\n`);
  }

  // Every printed line goes through here: the run log is written without escape sequences, but an older one, or a
  // program that ignores NO_COLOR, may still hold some. --raw prints the file byte for byte.
  const shownLine = (line: string): string => (options.raw ? line : stripAnsi(line));
  const emitLine = (line: string): void => {
    const text = shownLine(line);
    out(options.json ? `${JSON.stringify(toLogLine(text))}\n` : `${text}\n`);
  };

  if (!following) {
    if (options.json && !options.follow) {
      out(`${JSON.stringify(shown.map((l) => toLogLine(shownLine(l))))}\n`);
    } else {
      shown.forEach(emitLine);
    }
    if (options.follow) {
      err(isLatest
        ? 'the job is not running; showing the last run\n'
        : `execution ${target.name} has ended; showing it (not following)\n`);
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

  // Everything read so far, the held partial line included: it is already in `pending`, so it must not be read twice.
  let offset = raw.length;
  // The segment being followed. The writer moves on to the next one when the current is full: this reads what is left of
  // the current one (a line may still land there), prints a held partial line as the line it is, and goes on.
  const baseFile = path.join(deps.configDir, 'logs', 'jobs', jobId, `${jobId}-${target.name}.log`);
  let currentN = lastSegment.n;
  const readRest = (): boolean => {
    let size: number;
    try {
      size = fs.statSync(segmentPath(baseFile, currentN)).size;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw e;
    }
    if (size <= offset) {
      return true;
    }
    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(segmentPath(baseFile, currentN), 'r');
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    offset = size;
    const chunk = Buffer.concat([pending, buf]);
    const cut = chunk.lastIndexOf(0x0a);
    pending = chunk.subarray(cut + 1);
    const lines = splitLines(chunk.subarray(0, cut + 1).toString('utf8'));
    lines.forEach(emitLine);
    scan(lines);
    return true;
  };
  const drain = (): void => {
    for (;;) {
      const present = readRest();
      if (present && !fs.existsSync(segmentPath(baseFile, currentN + 1))) {
        return;
      }
      const later = (listRunSegments(path.dirname(baseFile), jobId).get(target.name) ?? []).find((s) => s.n > currentN);
      if (later === undefined) {
        if (!present) {
          // Nothing left to follow: the file is gone and no segment took over (the log was deleted, not rotated).
          throw new Error(`ENOENT: ${segmentPath(baseFile, currentN)} no longer exists`);
        }
        return;
      }
      if (pending.length > 0) {
        const lines = splitLines(pending.toString('utf8'));
        pending = Buffer.alloc(0);
        lines.forEach(emitLine);
        scan(lines);
      }
      const lostFrom = present ? currentN + 1 : currentN;
      const lost = later.n - lostFrom;
      if (lost > 0) {
        err(`[orch] ${lost} ${plural(lost, 'segment', 'segments')} of this execution ${plural(lost, 'was', 'were')} dropped by log rotation while following; `
          + `the output of ${lost === 1 ? `segment ${lostFrom}` : `segments ${lostFrom}-${later.n - 1}`} is lost. Read faster, or raise keepSegments (docs/daemon-config.md)\n`);
      }
      currentN = later.n;
      offset = 0;
    }
  };

  let interrupted = false;
  let wake: (() => void) | null = null;
  const onSigint = (): void => { interrupted = true; wake?.(); };
  process.on('SIGINT', onSigint);
  const time = deps.time ?? systemTime;
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const timer = time.after(ms, resolve);
    wake = () => { timer.cancel(); resolve(); };
  });

  const historyEveryMs = Math.max(pollMs * 8, pollMs);
  let lastHistoryCheck = time.now();
  try {
    while (ended === null && !interrupted) {
      await sleep(pollMs);
      if (interrupted) {
        break;
      }
      drain();
      if (ended === null && time.now() - lastHistoryCheck >= historyEveryMs) {
        lastHistoryCheck = time.now();
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
    err(`Lost track of the run while following (${getErrorMessage(e)}). The run may still be going: read it again with: orch job ${jobId} logs -f\n`);
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
