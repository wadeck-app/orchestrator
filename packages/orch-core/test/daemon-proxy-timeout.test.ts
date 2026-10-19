import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DaemonProxy } from '../src/daemon-proxy.js';

// restart-job answers after the old instance is really gone, which can take well over the 5 s every call used to get.
describe('DaemonProxy.send timeout', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-proxy-'));
    fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ port: 47999, pid: process.pid, startedAt: new Date().toISOString() }));
    fs.writeFileSync(path.join(dir, 'health_token'), 'token');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ ok: true, result: 1 }), { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is 5 s unless the caller asks for more', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await new DaemonProxy(dir).send('list-jobs');

    expect(spy).toHaveBeenCalledWith(5000);
  });

  it('is what the caller asked for', async () => {
    const spy = vi.spyOn(AbortSignal, 'timeout');

    await new DaemonProxy(dir).send('restart-job', { id: 'x' }, { timeoutMs: 30_000 });

    expect(spy).toHaveBeenCalledWith(30_000);
  });
});
