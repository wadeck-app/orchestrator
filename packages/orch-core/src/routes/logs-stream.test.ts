import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { logsRoutes } from './logs.js';
import type { IdleSignal } from '../route-host.js';

// The stream's idle bookkeeping is not what these tests are about.
const noIdle = (): IdleSignal => ({ reset: () => undefined, addSseConnection: () => undefined, removeSseConnection: () => undefined });

/*
 * Reported as: "with two jobs, opening the logs of the first AFTER the second was launched shows the
 * first's lines AND the second's".
 *
 * Exercised through a real SSE connection rather than the helper functions, because the defect is in
 * what the poll loop decides to follow while a connection is open - findLatestLogFile is right about
 * every question it is asked.
 *
 * Nothing here waits for time. The poll timer is the one the host passes in (`timers`), and the test runs the poll by
 * hand; what it expects is awaited as an event on the stream (a line arriving). To show that something did NOT
 * happen, the test makes the poll run once more over a line that must arrive, and checks after that line.
 */

const POLL_MS = 500;

function jobDir(configDir: string, jobId: string): string {
  const dir = path.join(configDir, 'logs', 'jobs', jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeRun(configDir: string, jobId: string, run: string, lines: string[]): string {
  const file = path.join(jobDir(configDir, jobId), `${jobId}-${run}.log`);
  fs.writeFileSync(file, lines.map(l => `${l}\n`).join(''));
  return file;
}

/** The poll timer, run by the test. `armed` resolves once the route has started it. */
function manualTimers() {
  const handle = { id: 'poll-handle' };
  let tick: (() => void) | null = null;
  let markArmed: () => void = () => undefined;
  const armed = new Promise<void>((resolve) => { markArmed = resolve; });
  let markCleared: () => void = () => undefined;
  const cleared = new Promise<void>((resolve) => { markCleared = resolve; });
  const started: number[] = [];
  const clearedHandles: unknown[] = [];
  return {
    timers: {
      setInterval: (fn: () => void, ms: number): unknown => { started.push(ms); tick = fn; markArmed(); return handle; },
      clearInterval: (h: unknown): void => { clearedHandles.push(h); markCleared(); },
    },
    armed, cleared, started, clearedHandles, handle,
    poll: (): void => { tick!(); },
  };
}

interface Stream {
  /** The `data:` payloads received, in order. */
  lines: string[];
  /** The `run-changed` events received (the new run's name). */
  runChanges: string[];
  waitForLine(line: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens the SSE stream. The history is replayed first; the first line arriving proves the connection is live. */
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

describe('the log stream stays on what the reader asked for', () => {
  let app: FastifyInstance;
  let configDir: string;
  let base: string;
  let clock: ReturnType<typeof manualTimers>;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logstream-'));
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

  it('never carries another job\'s lines, even while that job is writing', async () => {
    const aFile = writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['a-one']);
    const bFile = writeRun(configDir, 'job-b', '2026-09-18T10-00-01', ['b-one']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('a-one');
    await clock.armed;

    fs.appendFileSync(bFile, 'b-two\n');
    clock.poll();
    // The line that must arrive after the poll above has looked at everything it was going to look at.
    fs.appendFileSync(aFile, 'a-two\n');
    clock.poll();
    await stream.waitForLine('a-two');
    await stream.close();

    expect(stream.lines).toEqual(['a-one', 'a-two']);
  });

  // The defect. A reader who picked a run is pinned to it: the poll loop must not decide, on its
  // own, that a newer file is what they wanted. It used to compare the latest file against the one
  // being followed and switch, which appended the next run's output to the run on screen - two runs
  // interleaved in one pane, with nothing saying where one ended.
  it('does not switch to a newer run under a reader who pinned one', async () => {
    const run1 = writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['run1-one']);
    const stream = await open(`${base}/api/logs/job-a/stream?run=2026-09-18T10-00-00`);
    await stream.waitForLine('run1-one');
    await clock.armed;

    // A second run of the SAME job starts while the first is on screen.
    writeRun(configDir, 'job-a', '2026-09-18T11-00-00', ['run2-one', 'run2-two']);
    clock.poll();
    fs.appendFileSync(run1, 'run1-two\n');
    clock.poll();
    await stream.waitForLine('run1-two');
    await stream.close();

    expect(stream.lines.filter(l => l.startsWith('run2-'))).toEqual([]);
    // The switch is announced synchronously by the poll, so it would be here by now.
    expect(stream.runChanges).toEqual([]);
  });

  // The unpinned case must keep following, otherwise fixing the above would break the live tail:
  // opening the page with no ?run= means "show me what is happening now".
  it('still follows the newest run when the reader pinned nothing, and says the run changed', async () => {
    writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['run1-one']);
    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('run1-one');
    await clock.armed;

    writeRun(configDir, 'job-a', '2026-09-18T11-00-00', ['run2-one']);
    clock.poll();
    await stream.waitForLine('run2-one');
    await stream.close();

    expect(stream.runChanges).toEqual(['2026-09-18T11-00-00']);
  });
});

/*
 * Inside an app-core module the poll timer must come from the module's context: app-core clears what
 * went through ctx when the module is unloaded or swapped, and knows nothing about a raw setInterval.
 */
describe('the poll timer of a log stream', () => {
  it('goes through the timers the host passes in, and is released when the reader leaves', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logstream-timers-'));
    writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['a-one']);
    const clock = manualTimers();
    const app = fastify();
    await app.register(logsRoutes, { configDir, idleTimer: noIdle(), timers: clock.timers });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    const stream = await open(`${base}/api/logs/job-a/stream`);
    await stream.waitForLine('a-one');
    await clock.armed;
    expect(clock.clearedHandles).toEqual([]);
    await stream.close();
    // The close handler runs on the server side once it sees the client gone: awaited as the event it is.
    await clock.cleared;
    await app.close();
    fs.rmSync(configDir, { recursive: true, force: true });

    expect(stream.lines).toContain('a-one');
    expect(clock.started).toEqual([POLL_MS]);
    expect(clock.clearedHandles).toEqual([clock.handle]);
  });
});
