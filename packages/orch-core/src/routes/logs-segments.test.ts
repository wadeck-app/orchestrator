import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { findLatestLogFile, listLogFiles, logsRoutes } from './logs.js';
import type { IdleSignal } from '../route-host.js';

/*
 * The log of one run can be several files once it is rotated by size: <id>-<stamp>.log, then .log.2, .log.3... (the same
 * naming as orchestrator-cli's log-rotation.ts, which writes them). The dashboard reads them as ONE run: the runs list
 * has one entry per run, the stream replays every kept segment in order and goes on in the next one when the writer
 * moves on, and a new segment is not a new run.
 */

const noIdle = (): IdleSignal => ({ reset: () => undefined, addSseConnection: () => undefined, removeSseConnection: () => undefined });

const RUN1 = '2026-09-18T10-00-00';
const RUN2 = '2026-09-18T11-00-00';

function jobDir(configDir: string, jobId: string): string {
  const dir = path.join(configDir, 'logs', 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Segment `n` of the run `stamp` (1 is the plain file). */
function seg(configDir: string, jobId: string, stamp: string, n: number, lines: string[]): string {
  const file = path.join(jobDir(configDir, jobId), `${jobId}-${stamp}.log${n > 1 ? `.${n}` : ''}`);
  fs.writeFileSync(file, lines.map(l => `${l}\n`).join(''));
  return file;
}

function manualTimers() {
  let tick: (() => void) | null = null;
  let markArmed: () => void = () => undefined;
  const armed = new Promise<void>((resolve) => { markArmed = resolve; });
  return {
    timers: {
      setInterval: (fn: () => void): unknown => { tick = fn; markArmed(); return 'handle'; },
      clearInterval: (): void => undefined,
    },
    armed,
    poll: (): void => { tick!(); },
  };
}

interface Stream {
  lines: string[];
  runChanges: string[];
  waitForLine(line: string): Promise<void>;
  close(): Promise<void>;
}

async function open(url: string): Promise<Stream> {
  const lines: string[] = [];
  const runChanges: string[] = [];
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const data = /^data: ([\s\S]*)$/.exec(part.trim());
        if (data) {
          lines.push(data[1]!);
        }
        const change = /^event: run-changed\ndata: ([\s\S]*)$/.exec(part.trim());
        if (change) {
          runChanges.push(change[1]!);
        }
      }
      for (const w of [...waiters]) {
        if (lines.includes(w.line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); }
      }
    }
  })();
  return {
    lines,
    runChanges,
    waitForLine: (line) => (lines.includes(line) ? Promise.resolve() : new Promise<void>((resolve) => { waiters.push({ line, resolve }); })),
    close: async () => {
      controller.abort();
      await pump.catch(() => { /* aborted on purpose */ });
    },
  };
}

describe('listing the runs of a job', () => {
  let configDir: string;
  beforeEach(() => { configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logseg-')); });
  afterEach(() => { fs.rmSync(configDir, { recursive: true, force: true }); });

  it('a rotated run is one entry; the latest file is the newest segment of the newest run', () => {
    seg(configDir, 'job-a', RUN1, 1, ['a']);
    seg(configDir, 'job-a', RUN1, 2, ['b']);
    seg(configDir, 'job-a', RUN2, 1, ['c']);
    seg(configDir, 'job-a', RUN2, 2, ['d']);
    seg(configDir, 'job-a', RUN2, 10, ['e']);
    const dir = jobDir(configDir, 'job-a');
    expect(findLatestLogFile(dir, 'job-a')).toBe(path.join(dir, `job-a-${RUN2}.log.10`));
    expect(listLogFiles(dir, 'job-a').map(f => path.basename(f))).toEqual([
      `job-a-${RUN1}.log`, `job-a-${RUN1}.log.2`, `job-a-${RUN2}.log`, `job-a-${RUN2}.log.2`, `job-a-${RUN2}.log.10`,
    ]);
  });

  it('files that only look like segments are ignored', () => {
    seg(configDir, 'job-a', RUN1, 1, ['a']);
    const dir = jobDir(configDir, 'job-a');
    for (const name of [`job-a-${RUN1}.log.1`, `job-a-${RUN1}.log.0`, `job-a-${RUN1}.log.bak`, `job-a-${RUN1}.log.2.tmp`]) {
      fs.writeFileSync(path.join(dir, name), 'x');
    }
    expect(listLogFiles(dir, 'job-a')).toEqual([path.join(dir, `job-a-${RUN1}.log`)]);
  });

  it('GET /api/logs/:jobId/runs has one entry per run, with the total size and the segment counts', async () => {
    seg(configDir, 'job-a', RUN1, 1, ['aaaa']);
    seg(configDir, 'job-a', RUN2, 3, ['bbbb']);
    seg(configDir, 'job-a', RUN2, 4, ['cc']);
    fs.writeFileSync(path.join(jobDir(configDir, 'job-a'), 'job-a-2026-09-01.log'), 'legacy');
    const app = fastify();
    await app.register(logsRoutes, { configDir, idleTimer: noIdle() });
    const res = await app.inject({ method: 'GET', url: '/api/logs/job-a/runs' });
    await app.close();
    expect(res.json()).toEqual([
      { name: RUN2, file: `job-a-${RUN2}.log.3`, sizeBytes: 8, segments: 2, droppedSegments: 2 },
      { name: RUN1, file: `job-a-${RUN1}.log`, sizeBytes: 5, segments: 1, droppedSegments: 0 },
      { name: '2026-09-01', file: 'job-a-2026-09-01.log', sizeBytes: 6, segments: 1, droppedSegments: 0 },
    ]);
  });
});

describe('the log stream over segments', () => {
  let app: FastifyInstance;
  let configDir: string;
  let base: string;
  let clock: ReturnType<typeof manualTimers>;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logseg-stream-'));
    clock = manualTimers();
    app = fastify();
    await app.register(logsRoutes, { configDir, idleTimer: noIdle(), timers: clock.timers });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await app.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('replays every kept segment in order, then goes on in the next segment without announcing a new run', async () => {
    seg(configDir, 'job-a', RUN1, 1, ['one', 'two']);
    const last = seg(configDir, 'job-a', RUN1, 2, ['three']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('three');
    await clock.armed;

    fs.appendFileSync(last, 'four\n');
    clock.poll();
    await stream.waitForLine('four');
    seg(configDir, 'job-a', RUN1, 3, ['five']);
    clock.poll();
    await stream.waitForLine('five');
    await stream.close();

    expect(stream.lines).toEqual(['one', 'two', 'three', 'four', 'five']);
    expect(stream.runChanges).toEqual([]);
  });

  it('a late line in the segment the writer just left is read before moving on; several new segments in one poll are all read', async () => {
    const first = seg(configDir, 'job-a', RUN1, 1, ['a']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('a');
    await clock.armed;

    fs.appendFileSync(first, 'b\n');
    seg(configDir, 'job-a', RUN1, 2, ['c']);
    seg(configDir, 'job-a', RUN1, 3, ['d']);
    clock.poll();
    await stream.waitForLine('d');
    await stream.close();

    expect(stream.lines).toEqual(['a', 'b', 'c', 'd']);
  });

  it('a reader pinned on a run follows its segments, and not the next run', async () => {
    seg(configDir, 'job-a', RUN1, 1, ['r1-a']);
    const stream = await open(`${base}/api/logs/job-a/stream?run=${RUN1}`);
    await stream.waitForLine('r1-a');
    await clock.armed;

    seg(configDir, 'job-a', RUN2, 1, ['r2-a']);
    const second = seg(configDir, 'job-a', RUN1, 2, ['r1-b']);
    clock.poll();
    await stream.waitForLine('r1-b');
    fs.appendFileSync(second, 'r1-late\n');
    clock.poll();
    await stream.waitForLine('r1-late');
    await stream.close();

    expect(stream.lines).toEqual(['r1-a', 'r1-b', 'r1-late']);
    expect(stream.runChanges).toEqual([]);
  });

  it('a new run still says so, once, and starts from its first segment', async () => {
    seg(configDir, 'job-a', RUN1, 1, ['r1']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('r1');
    await clock.armed;

    seg(configDir, 'job-a', RUN2, 1, ['r2-a']);
    seg(configDir, 'job-a', RUN2, 2, ['r2-b']);
    clock.poll();
    await stream.waitForLine('r2-b');
    await stream.close();

    expect(stream.runChanges).toEqual([RUN2]);
    expect(stream.lines).toEqual(['r1', 'r2-a', 'r2-b']);
  });

  it('segments dropped while the reader was behind: it goes on at the oldest one kept', async () => {
    const first = seg(configDir, 'job-a', RUN1, 1, ['a']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('a');
    await clock.armed;

    seg(configDir, 'job-a', RUN1, 2, ['lost']);
    seg(configDir, 'job-a', RUN1, 3, ['kept-3']);
    seg(configDir, 'job-a', RUN1, 4, ['kept-4']);
    fs.rmSync(first);
    fs.rmSync(path.join(jobDir(configDir, 'job-a'), `job-a-${RUN1}.log.2`));
    clock.poll();
    await stream.waitForLine('kept-4');
    await stream.close();

    expect(stream.lines).toEqual(['a', 'kept-3', 'kept-4']);
  });

  it('?run= cannot name a file outside the job\'s folder', async () => {
    seg(configDir, 'job-a', RUN1, 1, ['mine']);
    fs.writeFileSync(path.join(configDir, 'secret.log'), 'secret\n');
    const res = await fetch(`${base}/api/logs/job-a/stream?run=${encodeURIComponent('../../../secret')}`, { signal: AbortSignal.timeout(300) }).catch(() => null);
    // Either nothing is streamed or the stream stays empty: the secret is never in it.
    const text = res === null ? '' : await res.text().catch(() => '');
    expect(text).not.toContain('secret');
  });
});
