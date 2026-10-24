import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runLogPath } from '../logger.js';
import type { RuntimeEntry } from '../types.js';
import { isUsableRun } from './history-strategy.js';
import type { LogCorpus, LogLine, LogReader } from './types.js';

/** A line is cut to this many characters: nothing downstream (regexes included) sees more. */
export const MAX_LOG_LINE = 2000;
/** Bytes read from the head of a past run's log. */
export const PAST_RUN_BYTE_CAP = 5 * 1024 * 1024;
/** Bytes read from the head of the open run's log by one readFrom. */
export const CURRENT_RUN_BYTE_CAP = 5 * 1024 * 1024;
/** Bytes looked at on each end of a log to find the [job:started] / [job:finished] markers. */
const MARKER_WINDOW = 8192;
/** Lines of a log (markers excluded) whose masked text makes the fingerprint. */
const FINGERPRINT_LINES = 20;

const LINE_RE = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})\] ?(.*)$/;

/**
 * Replaces what varies between two runs of the same job (numbers, hex ids, paths) so that the remaining text
 * is the "shape" of the line. Shared by the fingerprint and the learned strategy.
 */
export function mask(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"']*/g, '<path>')
    .replace(/(?<![\w<])\/[\w.-]+(?:\/[\w.-]+)+/g, '<path>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#');
}

function parseLines(text: string, fallback: Date): LogLine[] {
  const out: LogLine[] = [];
  let prev = fallback;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const m = LINE_RE.exec(line);
    if (m) {
      const ts = new Date(`${m[1]}T${m[2]}Z`);
      prev = Number.isNaN(ts.getTime()) ? prev : ts;
      out.push({ ts: prev, text: m[3]!.slice(0, MAX_LOG_LINE) });
    } else {
      out.push({ ts: prev, text: line.slice(0, MAX_LOG_LINE) });
    }
  }
  return out;
}

export interface FileLogReaderOptions {
  /** Timestamp given to lines before the first stamped one. */
  runStartedAt: string;
  /** Most bytes one readFrom returns. */
  byteCap?: number;
  /** The run is over: a last line without a newline is complete. */
  finished?: boolean;
}

/** Reads `file` by byte offset. A missing file is an empty log; any other read error is thrown with its cause. */
export function createFileLogReader(file: string, options: FileLogReaderOptions): LogReader {
  const byteCap = options.byteCap ?? CURRENT_RUN_BYTE_CAP;
  const finished = options.finished === true;
  const fallback = new Date(options.runStartedAt);

  const withFd = <T>(empty: T, fn: (fd: number, size: number) => T): T => {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return empty;
      }
      throw err;
    }
    try {
      return fn(fd, fs.fstatSync(fd).size);
    } finally {
      fs.closeSync(fd);
    }
  };

  const read = (fd: number, start: number, length: number): Buffer => {
    const buf = Buffer.alloc(length);
    let got = 0;
    while (got < length) {
      const n = fs.readSync(fd, buf, got, length - got, start + got);
      if (n === 0) {
        break;
      }
      got += n;
    }
    return buf.subarray(0, got);
  };

  return {
    exists: () => fs.existsSync(file),

    size: () => withFd(0, (_fd, size) => size),

    readFrom(offset) {
      return withFd({ lines: [], nextOffset: offset, truncated: false }, (fd, size) => {
        if (offset >= size) {
          return { lines: [], nextOffset: offset, truncated: false };
        }
        const truncated = size - offset > byteCap;
        const buf = read(fd, offset, Math.min(size - offset, byteCap));
        let consumed = buf.length;
        if (!finished || truncated) {
          const lastNewline = buf.lastIndexOf(0x0a);
          // No newline in a buffer that hit the cap: one enormous line, taken whole so the reader never stalls.
          consumed = lastNewline >= 0 ? lastNewline + 1 : (truncated ? buf.length : 0);
        }
        const text = buf.subarray(0, consumed).toString('utf8');
        const lines = parseLines(text.endsWith('\n') ? text.slice(0, -1) : text, fallback);
        return { lines: consumed === 0 ? [] : lines, nextOffset: offset + consumed, truncated };
      });
    },

    tail(maxBytes) {
      return withFd([] as LogLine[], (fd, size) => {
        const start = Math.max(0, size - maxBytes);
        let text = read(fd, start, size - start).toString('utf8');
        if (start > 0) {
          const nl = text.indexOf('\n');
          text = nl < 0 ? '' : text.slice(nl + 1);
        }
        if (!finished) {
          const nl = text.lastIndexOf('\n');
          text = nl < 0 ? '' : text.slice(0, nl + 1);
        }
        if (text === '') {
          return [];
        }
        return parseLines(text.endsWith('\n') ? text.slice(0, -1) : text, fallback);
      });
    },

    fingerprint() {
      const head = withFd([] as LogLine[], (fd, size) => parseLines(read(fd, 0, Math.min(size, 16384)).toString('utf8'), fallback));
      const shapes = head.filter(l => l.text !== '' && !l.text.startsWith('[job:')).slice(0, FINGERPRINT_LINES).map(l => mask(l.text));
      return shapes.length === 0 ? '' : createHash('sha1').update(shapes.join('\n')).digest('hex').slice(0, 16);
    },
  };
}

export interface LogCorpusOptions {
  configDir: string;
  jobId: string;
  /** The run history of the job (state.ts), open run included. */
  history: readonly RuntimeEntry[];
  /** The open run being estimated. */
  currentStartedAt: string;
  /** Only runs that started before this ISO time (leave-one-out replay). */
  olderThan?: string;
  pastByteCap?: number;
}

/** `<jobId>-YYYY-MM-DDTHH-MM-SS.log` (per run). The legacy daily `<jobId>-YYYY-MM-DD.log` does not match. */
function runFileKey(jobId: string, name: string): string | null {
  const prefix = `${jobId}-`;
  if (!name.startsWith(prefix) || !name.endsWith('.log')) {
    return null;
  }
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/.exec(name.slice(prefix.length, -4));
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}` : null;
}

const END_REASONS = new Set(['timeout', 'manual-kill', 'resource-limit']);

/**
 * The run a log file remembers, from its [job:started] / [job:finished] markers; null when the file does not say
 * how the run ended (still open, or written by something else).
 */
function entryFromLog(file: string, key: string): RuntimeEntry | null {
  const startedAt = `${key}.000Z`;
  const reader = createFileLogReader(file, { runStartedAt: startedAt, finished: true });
  const head = reader.readFrom(0);
  const tailLines = reader.tail(MARKER_WINDOW);
  const all = [...head.lines.slice(0, 20), ...tailLines];
  const started = all.find(l => l.text.startsWith('[job:started]'));
  const pid = started ? Number(/pid=(\d+)/.exec(started.text)?.[1] ?? 0) : 0;
  for (let i = all.length - 1; i >= 0; i--) {
    const text = all[i]!.text;
    if (text.startsWith('[job:skipped]')) {
      return { startedAt, finishedAt: all[i]!.ts.toISOString(), exitCode: null, pid, skipped: true };
    }
    const m = /^\[job:finished\] exitCode=(-?\d+) duration=([\d.]+)s(?: reason=(\S+))?/.exec(text);
    if (m) {
      const reason = m[3];
      return {
        startedAt,
        finishedAt: new Date(Date.parse(startedAt) + Number(m[2]) * 1000).toISOString(),
        exitCode: Number(m[1]),
        pid,
        ...(reason !== undefined && END_REASONS.has(reason) ? { endReason: reason as RuntimeEntry['endReason'] } : {}),
      };
    }
  }
  return null;
}

export function createLogCorpus(options: LogCorpusOptions): LogCorpus {
  const logDir = path.join(options.configDir, 'logs', 'jobs', options.jobId);
  const pastByteCap = options.pastByteCap ?? PAST_RUN_BYTE_CAP;
  const compact = (iso: string): string => iso.replace(/:/g, '-').slice(0, 19);
  const readerOf = (entry: RuntimeEntry): LogReader => createFileLogReader(
    runLogPath(logDir, options.jobId, entry.startedAt), { runStartedAt: entry.startedAt, byteCap: pastByteCap, finished: true });

  return {
    currentRun() {
      return createFileLogReader(runLogPath(logDir, options.jobId, options.currentStartedAt), { runStartedAt: options.currentStartedAt });
    },

    pastRuns(limit) {
      const before = (startedAt: string): boolean => options.olderThan === undefined || startedAt < options.olderThan;
      const currentKey = compact(options.currentStartedAt);
      const known = new Set(options.history.map(e => compact(e.startedAt)));
      known.add(currentKey);

      // Candidates by start time: usable history runs, and log files no history entry accounts for.
      const candidates: Array<{ startedAt: string; entry?: RuntimeEntry; key?: string }> = [];
      for (const entry of options.history) {
        if (isUsableRun(entry) && compact(entry.startedAt) !== currentKey && before(entry.startedAt)) {
          candidates.push({ startedAt: entry.startedAt, entry });
        }
      }
      let names: string[] = [];
      try {
        names = fs.readdirSync(logDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw err;
        }
      }
      for (const name of names) {
        const key = runFileKey(options.jobId, name);
        if (key !== null && !known.has(key.replace(/:/g, '-')) && before(`${key}.000Z`)) {
          candidates.push({ startedAt: `${key}.000Z`, key });
        }
      }
      candidates.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

      const out: Array<{ entry: RuntimeEntry; reader: LogReader }> = [];
      for (const c of candidates) {
        if (out.length >= limit) {
          break;
        }
        const entry = c.entry ?? entryFromLog(path.join(logDir, `${options.jobId}-${compact(c.startedAt)}.log`), c.key!);
        if (entry && isUsableRun(entry)) {
          out.push({ entry, reader: readerOf(entry) });
        }
      }
      return out;
    },
  };
}
