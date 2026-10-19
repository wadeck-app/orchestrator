import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { DaemonUnavailableError } from '@wadeck-app/orch-core/daemon-proxy';
import { ALLOWED_ROUTES } from './routes.js';
import backend, { createBackend } from './index.js';

/*
 * A real Fastify instance stands in for app-core's server: it supports path parameters, which is the
 * contract this module is written against (`req.params` carries the module's own `:names`).
 * The daemon is replaced by a scripted client; what is under test is that orch-core's route files
 * come up inside a module, with exactly the routes the dashboard needs and no others.
 */
type Send = (command: string, payload?: unknown) => Promise<unknown>;

interface Host {
  app: FastifyInstance;
  /** Stands in for the module context; cast where it is handed over, since the SDK's timer handle type varies by version. */
  ctx: unknown;
  registered: string[];
  /** Intervals started through the context, and the handles it was asked to clear. */
  timers: { started: number[]; cleared: unknown[] };
}

function makeHost(): Host {
  const app = Fastify();
  const registered: string[] = [];
  const timers = { started: [] as number[], cleared: [] as unknown[] };
  const ctx = {
    setInterval(_fn: () => void, ms: number): unknown {
      timers.started.push(ms);
      return { timer: timers.started.length };
    },
    clearInterval(handle: unknown): void {
      timers.cleared.push(handle);
    },
    registerRoute(method: string, subPath: string, handler: ModuleRouteHandler): void {
      registered.push(`${method} ${subPath}`);
      app.route({ method: method as 'GET', url: subPath, handler: handler as never });
    },
  };
  return { app, ctx, registered, timers };
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-module-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function boot(send: Send): Promise<Host> {
  const host = makeHost();
  await createBackend({ configDir: tmpDir, proxy: { send } })(host.ctx as ModuleContext);
  await host.app.ready();
  return host;
}

describe('the published routes', () => {
  it('are exactly the allow-list: every allowed route is registered, nothing else', async () => {
    const { registered, app } = await boot(async () => []);
    expect([...registered].sort()).toEqual([...ALLOWED_ROUTES].sort());
    await app.close();
  });

  it.each([
    'GET /api/secrets', 'POST /api/secrets', 'DELETE /api/secrets/:name',
    'POST /api/exec', 'GET /api/exec', 'GET /api/exec/:runId', 'DELETE /api/exec/:runId',
    'POST /api/jobs/import', 'GET /api/jobs/export',
    'POST /api/heartbeat', 'GET /api/events',
  ])('do not include %s, which no dashboard page needs', async (route) => {
    const { registered, app } = await boot(async () => []);
    expect(registered).not.toContain(route);
    await app.close();
  });
});

describe('serving the dashboard routes through the module', () => {
  it('lists jobs with their run history, from the daemon', async () => {
    const calls: string[] = [];
    const { app } = await boot(async (command) => {
      calls.push(command);
      if (command === 'list-jobs') {
        return [{ id: 'j1', type: 'cron', command: 'echo' }];
      }
      if (command === 'list-state') {
        return { j1: [{ startedAt: '2026-01-01T00:00:00Z', exitCode: 0 }] };
      }
      return {};
    });

    const res = await app.inject({ method: 'GET', url: '/api/jobs' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{
      job: { id: 'j1', type: 'cron', command: 'echo' },
      runHistory: [{ startedAt: '2026-01-01T00:00:00Z', exitCode: 0 }],
      uptimePercent: null,
    }]);
    expect(calls).toEqual(expect.arrayContaining(['list-jobs', 'list-state']));
    await app.close();
  });

  it('reaches a parameterised route with its own :id', async () => {
    const seen: unknown[] = [];
    const { app } = await boot(async (command, payload) => {
      seen.push([command, payload]);
      return { killed: true, count: 1 };
    });

    const res = await app.inject({ method: 'POST', url: '/api/jobs/j1/kill' });

    expect(res.statusCode).toBe(204);
    expect(seen).toContainEqual(['kill-job', expect.objectContaining({ id: 'j1' })]);
    await app.close();
  });

  it('serves the telemetry of one run, the run passed through, from the daemon', async () => {
    const seen: unknown[] = [];
    const { app } = await boot(async (command, payload) => {
      seen.push([command, payload]);
      return { run: 'r', available: true, samples: [] };
    });

    const res = await app.inject({ method: 'GET', url: '/api/jobs/j1/telemetry?run=2026-01-01T00%3A00%3A00Z' });

    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(true);
    expect(seen).toContainEqual(['get-run-telemetry', { jobId: 'j1', run: '2026-01-01T00:00:00Z' }]);
    await app.close();
  });

  it('answers 503 daemon-not-running, as the dashboard server does, when the daemon is down', async () => {
    const { app } = await boot(async () => { throw new DaemonUnavailableError(); });

    const res = await app.inject({ method: 'GET', url: '/api/jobs' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'daemon-not-running' });
    await app.close();
  });
});

describe('the module entry', () => {
  const saved = process.env['ORCH_CONFIG_DIR'];
  afterEach(() => {
    if (saved === undefined) { delete process.env['ORCH_CONFIG_DIR']; } else { process.env['ORCH_CONFIG_DIR'] = saved; }
  });

  it('builds its daemon client from ORCH_CONFIG_DIR, and reports a missing daemon instead of crashing', async () => {
    process.env['ORCH_CONFIG_DIR'] = tmpDir;
    const host = makeHost();

    await backend(host.ctx as ModuleContext);
    await host.app.ready();
    const res = await host.app.inject({ method: 'GET', url: '/api/jobs' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'daemon-not-running' });
    await host.app.close();
  });
});

describe('timers', () => {
  it('a log stream polls through the context\'s timers and releases its own when the reader leaves, never a raw setInterval', async () => {
    const logDir = path.join(tmpDir, 'logs', 'jobs', 'j1');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'j1-2026-09-18T10-00-00.log'), 'first line\n');
    const rawSetInterval = vi.spyOn(globalThis, 'setInterval');
    const host = makeHost();
    await createBackend({ configDir: tmpDir, proxy: { send: async () => [] } })(host.ctx as ModuleContext);
    await host.app.listen({ port: 0, host: '127.0.0.1' });
    const address = host.app.server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/logs/j1/stream`, { signal: controller.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('first line');
    // The history is sent before the poll timer is armed (the server awaits the file read in between), so the
    // first chunk can reach the reader first: wait for the timer instead of assuming it exists.
    for (let i = 0; i < 50 && host.timers.started.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(host.timers.started).toEqual([500]);
    expect(host.timers.cleared).toEqual([]);

    controller.abort();
    await reader.read().catch(() => undefined);
    for (let i = 0; i < 50 && host.timers.cleared.length === 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // The handle the context gave out is the one handed back to it.
    expect(host.timers.cleared).toEqual([{ timer: 1 }]);
    // Fastify and the HTTP client may own timers of their own; the route files must not add one.
    expect(rawSetInterval.mock.calls.filter(([, ms]) => ms === 500)).toEqual([]);
    await host.app.close();
  });
});
