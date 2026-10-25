import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IdleSignal, RouteHost } from '../route-host.js';

const JOB_ID_RE = /^[a-z0-9-]+$/i;
const POLL_INTERVAL_MS = 500;

/** One file of a run's log. A run that was never rotated has one, segment 1. */
interface Segment {
  /** 1 for `<id>-<stamp>.log`, n for `<id>-<stamp>.log.<n>` (size-based rotation, orchestrator-cli's log-rotation.ts). */
  n: number;
  file: string;
}

/** One log in the job's folder: a run (possibly several segments) or a legacy daily file. */
interface LogEntry {
  /** What follows `<jobId>-` in the name: the run stamp, or the date of a legacy daily file. */
  key: string;
  segments: Segment[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every log of a job, oldest->newest, each with its segments in order. Supports the formats:
 *   - per-run:  <jobId>-YYYY-MM-DDTHH-MM-SS.log, then .log.2, .log.3... when the run was rotated by size
 *   - daily:    <jobId>-YYYY-MM-DD.log             (legacy)
 * The segments of a run whose first ones were dropped start at the first one kept.
 */
function listLogEntries(logDir: string, jobId: string): LogEntry[] {
  let names: string[];
  try { names = fs.readdirSync(logDir); } catch { return []; }
  const esc = escapeRegExp(jobId);
  const runPat   = new RegExp(`^${esc}-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.log(?:\\.([2-9]|[1-9]\\d+))?$`);
  const dailyPat = new RegExp(`^${esc}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
  const byKey = new Map<string, Segment[]>();
  for (const name of names) {
    const run = runPat.exec(name);
    const key = run?.[1] ?? dailyPat.exec(name)?.[1];
    if (key === undefined) {
      continue;
    }
    const list = byKey.get(key) ?? [];
    list.push({ n: run?.[2] === undefined ? 1 : Number(run[2]), file: path.join(logDir, name) });
    byKey.set(key, list);
  }
  return [...byKey.keys()].sort().map(key => ({ key, segments: byKey.get(key)!.sort((a, b) => a.n - b.n) }));
}

/**
 * Returns all log files for a job, sorted oldest->newest (the segments of a run in their order).
 */
export function listLogFiles(logDir: string, jobId: string): string[] {
  return listLogEntries(logDir, jobId).flatMap(e => e.segments.map(s => s.file));
}

/**
 * Returns the path to the most recent log file for a job, or null if none exists. For a rotated run that is the newest
 * segment, the one still being written.
 */
export function findLatestLogFile(logDir: string, jobId: string): string | null {
  const files = listLogFiles(logDir, jobId);
  return files.length > 0 ? files[files.length - 1]! : null;
}

/**
 * Where the stream's poll timer comes from. The dashboard server uses the global timers; an app-core
 * module passes its context's, which app-core clears when the module is unloaded or swapped.
 * The handle is opaque: whatever setInterval returns is what clearInterval gets back.
 */
export interface LogsTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const GLOBAL_TIMERS: LogsTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => { clearInterval(handle as NodeJS.Timeout); },
};

function sizeOf(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export async function logsRoutes(
  fastify: RouteHost,
  opts: { configDir: string; idleTimer: IdleSignal; timers?: LogsTimers }
): Promise<void> {
  const { configDir, idleTimer, timers = GLOBAL_TIMERS } = opts;

  // List available run log files for a job: one entry per run, however many segments it has
  fastify.get('/api/logs/:jobId/runs', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!JOB_ID_RE.test(jobId)) {
      return reply.code(400).send({ error: 'invalid-job-id' });
    }
    idleTimer.reset();
    const logDir = path.join(configDir, 'logs', 'jobs', jobId);
    const runs = listLogEntries(logDir, jobId).map(e => ({
      name: e.key,
      // The first segment kept; the whole run when it was not rotated.
      file: path.basename(e.segments[0]!.file),
      sizeBytes: e.segments.reduce((sum, s) => sum + sizeOf(s.file), 0),
      segments: e.segments.length,
      droppedSegments: e.segments[0]!.n - 1,
    })).reverse(); // most recent first
    return reply.send(runs);
  });

  fastify.get('/api/logs/:jobId/stream', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!JOB_ID_RE.test(jobId)) {
      return reply.code(400).send({ error: 'invalid-job-id' });
    }

    // Optional ?run=<name> to stream a specific run log
    const runName = (req.query as { run?: string }).run;

    const logDir = path.join(configDir, 'logs', 'jobs', jobId);

    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    idleTimer.addSseConnection();

    const send = (line: string): void => {
      reply.raw.write(`data: ${line}\n\n`);
    };

    /** The log being followed: a run (or daily file) by key, the segment being read and how far into it. */
    let cursor: { key: string; n: number; offset: number } | null = null;

    const fileOf = (entry: LogEntry, n: number): string | undefined => entry.segments.find(s => s.n === n)?.file;

    /** Sends what is new in the segment of the cursor. A segment dropped since is nothing to read. */
    const readNew = (entry: LogEntry): void => {
      const file = fileOf(entry, cursor!.n);
      if (file === undefined) {
        return;
      }
      let size: number;
      try { size = fs.statSync(file).size; } catch { return; }
      if (size <= cursor!.offset) {
        return;
      }
      const buf = Buffer.alloc(size - cursor!.offset);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, buf.length, cursor!.offset); } finally { fs.closeSync(fd); }
      cursor!.offset = size;
      const text = buf.toString('utf8');
      for (const line of (text.endsWith('\n') ? text.slice(0, -1) : text).split(/\r?\n/)) {
        send(line);
      }
    };

    /**
     * Reads the rest of the followed log: its current segment, then every later segment the writer moved on to. A line can
     * still land in the segment just left, so the rest of it is read before leaving. Segments dropped meanwhile (the reader
     * was too slow) are skipped: it goes on at the oldest one kept.
     */
    const follow = (): void => {
      for (;;) {
        const entry = listLogEntries(logDir, jobId).find(e => e.key === cursor!.key);
        if (entry === undefined) {
          return;
        }
        readNew(entry);
        const next = entry.segments.find(s => s.n > cursor!.n);
        if (next === undefined) {
          return;
        }
        cursor = { key: cursor!.key, n: next.n, offset: 0 };
      }
    };

    // Send historical lines from the requested run log, or the latest. The run is looked up among the job's own logs, so a
    // name that is a path names nothing.
    const entries = listLogEntries(logDir, jobId);
    const first = runName !== undefined ? entries.find(e => e.key === runName) : entries[entries.length - 1];
    if (first !== undefined) {
      cursor = { key: first.key, n: first.segments[0]!.n, offset: 0 };
      try {
        follow();
      } catch {
        // log file may not be readable yet
      }
    }

    // Poll for new lines every POLL_INTERVAL_MS (reliable on Windows, avoids fs.watch quirks)
    const pollTimer = timers.setInterval(() => {
      try {
        // A reader who named a run is pinned to it. Following the newest file regardless is what
        // appended the NEXT run's output to the run on screen: two runs interleaved in one pane,
        // with nothing marking where the first ended. Reported as "it shows the logs of both".
        // Without ?run= the request means "what is happening now", so there the switch is the point.
        if (runName === undefined) {
          const latest = listLogEntries(logDir, jobId).pop();
          if (latest === undefined) {
            return;
          }

          // A new run started, or the date rolled over on a legacy daily file. A new SEGMENT of the same run is not a new run.
          if (latest.key !== cursor?.key) {
            cursor = { key: latest.key, n: latest.segments[0]!.n, offset: 0 };
            // Signal the client to reset its line buffer before the new run's content arrives,
            // so two runs are never interleaved in the same pane.
            reply.raw.write(`event: run-changed\ndata: ${latest.key}\n\n`);
          }
        } else if (cursor === null) {
          // A pinned run whose file had not appeared yet starts being followed when it does.
          const pinned = listLogEntries(logDir, jobId).find(e => e.key === runName);
          if (pinned === undefined) {
            return;
          }
          cursor = { key: pinned.key, n: pinned.segments[0]!.n, offset: 0 };
        }
        if (cursor === null) {
          return;
        }
        follow();
      } catch {
        // transient error - file may be rotating
      }
    }, POLL_INTERVAL_MS);

    req.raw.on('close', () => {
      timers.clearInterval(pollTimer);
      idleTimer.removeSseConnection();
    });
  });
}
