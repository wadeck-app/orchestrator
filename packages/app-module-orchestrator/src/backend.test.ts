import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { DaemonUnavailableError } from '@wadeck-app/orch-server/daemon-proxy';
import { ALLOWED_ROUTES } from './routes.js';
import backend, { createBackend } from './backend.js';

/*
 * A real Fastify instance stands in for app-core's server: it supports path parameters, which is the
 * contract this module is written against (`req.params` carries the module's own `:names`).
 * The daemon is replaced by a scripted client; what is under test is that orch-server's route files
 * come up inside a module, with exactly the routes the dashboard needs and no others.
 */
type Send = (command: string, payload?: unknown) => Promise<unknown>;

interface Host {
  app: FastifyInstance;
  ctx: Pick<ModuleContext, 'registerRoute'>;
  registered: string[];
}

function makeHost(): Host {
  const app = Fastify();
  const registered: string[] = [];
  const ctx = {
    registerRoute(method: string, subPath: string, handler: ModuleRouteHandler): void {
      registered.push(`${method} ${subPath}`);
      app.route({ method: method as 'GET', url: subPath, handler: handler as never });
    },
  };
  return { app, ctx, registered };
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
    'POST /api/heartbeat', 'GET /api/events', 'GET /api/open',
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
