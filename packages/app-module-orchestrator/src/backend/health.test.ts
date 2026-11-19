import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleContext, ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { DaemonUnavailableError } from '@wadeck-app/orch-core/daemon-proxy';
import { createBackend } from './index.js';

/*
 * app-core-cli starts the new version's server before it switches to it and asks each module GET /health (module-authoring.md,
 * "Update test of app-core-cli"). The answer is read by a machine: { ok, checks: [{ name, ok, detail? }] }, nothing else.
 * With a /health, app-core no longer tests the module's pages, so this tests what they read: one daemon command per page.
 */
type Send = (command: string, payload?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-health-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

async function boot(send: Send): Promise<FastifyInstance> {
  const app = Fastify();
  const ctx = {
    setInterval: () => 0,
    clearInterval: () => undefined,
    registerRoute(method: string, subPath: string, handler: ModuleRouteHandler): void {
      app.route({ method: method as 'GET', url: subPath, handler: handler as never });
    },
  };
  await createBackend({ configDir: tmpDir, proxy: { send } })(ctx as unknown as ModuleContext);
  await app.ready();
  return app;
}

/** A daemon that answers every command the pages read. */
const healthyDaemon: Send = async (command) => {
  switch (command) {
    case 'get-daemon-info': return { version: '2026.11.19-001-abc' };
    case 'list-jobs': return [{ id: 'a' }, { id: 'b' }];
    case 'list-state': return {};
    case 'get-schedule': return [];
    case 'list-audit': return [];
    case 'list-failures': return [];
    default: throw new Error(`unexpected command ${command}`);
  }
};

interface Check { name: string; ok: boolean; detail?: string }
const get = async (app: FastifyInstance): Promise<{ status: number; body: { ok: boolean; checks: Check[] } }> => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  return { status: res.statusCode, body: res.json() };
};

describe('GET /health (the update test of app-core-cli)', () => {
  it('a daemon that answers everything the pages read: ok, one check per page', async () => {
    const app = await boot(healthyDaemon);

    const { status, body } = await get(app);

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.map((c) => c.name)).toEqual(['daemon', 'jobs', 'schedule', 'audit', 'failures']);
    expect(body.checks.every((c) => c.ok)).toBe(true);
    expect(body.checks[0]!.detail).toBe('answers (version 2026.11.19-001-abc)');
    expect(body.checks[1]!.detail).toBe('2 jobs');
    await app.close();
  });

  it('reads only: the daemon is asked the commands the pages use, with a short timeout, and the audit for one entry', async () => {
    const asked: Array<[string, unknown, number | undefined]> = [];
    const app = await boot(async (command, payload, options) => {
      asked.push([command, payload, options?.timeoutMs]);
      return healthyDaemon(command, payload, options);
    });

    await get(app);

    expect(asked.map((a) => a[0]).sort()).toEqual(['get-daemon-info', 'get-schedule', 'list-audit', 'list-failures', 'list-jobs', 'list-state']);
    expect(asked.find((a) => a[0] === 'list-audit')![1]).toEqual({ limit: 1 });
    expect(asked.every((a) => typeof a[2] === 'number' && a[2] <= 3000)).toBe(true);
    await app.close();
  });

  it('a daemon that does not run is one failed check saying what to run, not five that repeat it', async () => {
    const app = await boot(async () => { throw new DaemonUnavailableError(); });

    const { status, body } = await get(app);

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]).toMatchObject({ name: 'daemon', ok: false });
    expect(body.checks[0]!.detail).toMatch(/orch start/);
    await app.close();
  });

  it('a page whose data fails is named, with the daemon reason, and the others stay ok', async () => {
    const app = await boot(async (command, payload, options) => {
      if (command === 'list-audit') { throw new Error('audit.ndjson is locked'); }
      return healthyDaemon(command, payload, options);
    });

    const { body } = await get(app);

    expect(body.ok).toBe(false);
    const audit = body.checks.find((c) => c.name === 'audit')!;
    expect(audit.ok).toBe(false);
    expect(audit.detail).toContain('audit.ndjson is locked');
    expect(body.checks.filter((c) => c.ok).map((c) => c.name)).toEqual(['daemon', 'jobs', 'schedule', 'failures']);
    await app.close();
  });

  it('an answer of the wrong shape is a failure, not a pass', async () => {
    const app = await boot(async (command, payload, options) => (command === 'list-jobs' ? { not: 'a list' } : healthyDaemon(command, payload, options)));

    const { body } = await get(app);

    expect(body.checks.find((c) => c.name === 'jobs')).toMatchObject({ ok: false, detail: expect.stringContaining('list') });
    await app.close();
  });

  it('never throws: whatever the daemon does, the answer is 200 in the agreed format', async () => {
    const app = await boot(async () => { throw 'a string, not an Error'; });

    const { status, body } = await get(app);

    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(typeof body.checks[0]!.detail).toBe('string');
    await app.close();
  });
});
