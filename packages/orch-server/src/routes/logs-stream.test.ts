import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import fastify, { type FastifyInstance } from 'fastify';
import { logsRoutes } from './logs.js';
import { IdleTimer } from '../idle-timer.js';

/*
 * Reported as: "with two jobs, opening the logs of the first AFTER the second was launched shows the
 * first's lines AND the second's".
 *
 * Exercised through a real SSE connection rather than the helper functions, because the defect is in
 * what the poll loop decides to follow while a connection is open - findLatestLogFile is right about
 * every question it is asked.
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

/** Opens the SSE stream and collects `data:` payloads until `settle` ms pass with no new line. */
async function collect(
  url: string,
  opts: { settleMs: number; afterFirst?: () => void | Promise<void> },
): Promise<string[]> {
  const lines: string[] = [];
  const controller = new AbortController();
  const res = await fetch(url, { signal: controller.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let firstSeen = false;

  const deadline = Date.now() + opts.settleMs * 6;
  let lastLineAt = Date.now();

  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() ?? '';
      for (const part of parts) {
        const m = /^data: ([\s\S]*)$/.exec(part.trim());
        if (m) { lines.push(m[1]!); lastLineAt = Date.now(); }
      }
      if (!firstSeen && lines.length > 0) {
        firstSeen = true;
        // The extra activity is started only once the connection is provably live and has replayed
        // history, so the test cannot pass by racing ahead of the stream.
        await opts.afterFirst?.();
      }
    }
  })();

  while (Date.now() < deadline && Date.now() - lastLineAt < opts.settleMs) {
    await new Promise(r => setTimeout(r, 50));
  }
  controller.abort();
  await pump.catch(() => { /* aborted on purpose */ });
  return lines;
}

describe('the log stream stays on what the reader asked for', () => {
  let app: FastifyInstance;
  let configDir: string;
  let base: string;

  beforeEach(async () => {
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logstream-'));
    app = fastify();
    await app.register(logsRoutes, { configDir, idleTimer: new IdleTimer(0, () => {}) });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('never carries another job\'s lines, even while that job is writing', async () => {
    writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['a-one']);
    const bFile = writeRun(configDir, 'job-b', '2026-09-18T10-00-01', ['b-one']);

    const lines = await collect(`${base}/api/logs/job-a/stream`, {
      settleMs: POLL_MS * 3,
      afterFirst: () => { fs.appendFileSync(bFile, 'b-two\n'); },
    });

    expect(lines).toContain('a-one');
    expect(lines.filter(l => l.startsWith('b-'))).toEqual([]);
  });

  // The defect. A reader who picked a run is pinned to it: the poll loop must not decide, on its
  // own, that a newer file is what they wanted. It used to compare the latest file against the one
  // being followed and switch, which appended the next run's output to the run on screen - two runs
  // interleaved in one pane, with nothing saying where one ended.
  it('does not switch to a newer run under a reader who pinned one', async () => {
    writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['run1-one']);

    const lines = await collect(`${base}/api/logs/job-a/stream?run=2026-09-18T10-00-00`, {
      settleMs: POLL_MS * 3,
      afterFirst: () => {
        // A second run of the SAME job starts while the first is on screen.
        writeRun(configDir, 'job-a', '2026-09-18T11-00-00', ['run2-one', 'run2-two']);
      },
    });

    expect(lines).toContain('run1-one');
    expect(lines.filter(l => l.startsWith('run2-'))).toEqual([]);
  });

  // The unpinned case must keep following, otherwise fixing the above would break the live tail:
  // opening the page with no ?run= means "show me what is happening now".
  it('still follows the newest run when the reader pinned nothing', async () => {
    writeRun(configDir, 'job-a', '2026-09-18T10-00-00', ['run1-one']);

    const lines = await collect(`${base}/api/logs/job-a/stream`, {
      settleMs: POLL_MS * 3,
      afterFirst: () => {
        writeRun(configDir, 'job-a', '2026-09-18T11-00-00', ['run2-one']);
      },
    });

    expect(lines).toContain('run2-one');
  });
});
