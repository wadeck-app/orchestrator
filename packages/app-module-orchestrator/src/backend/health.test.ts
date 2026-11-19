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
 */
type Send = (command: string, payload?: unknown) => Promise<unknown>;

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

describe('GET /health (the update test of app-core-cli)', () => {
  it('a daemon that answers: ok, with the checks that were made', async () => {
    const asked: string[] = [];
    const app = await boot(async (command) => { asked.push(command); return { version: '2026.11.19-001-abc' }; });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      checks: [{ name: 'daemon', ok: true, detail: 'answers (version 2026.11.19-001-abc)' }],
    });
    // Read-only: the one question is the daemon's own info.
    expect(asked).toEqual(['get-daemon-info']);
    await app.close();
  });

  it('a daemon that does not run: not ok, and the detail says what to run', async () => {
    const app = await boot(async () => { throw new DaemonUnavailableError(); });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> };
    expect(body.ok).toBe(false);
    expect(body.checks).toHaveLength(1);
    expect(body.checks[0]).toMatchObject({ name: 'daemon', ok: false });
    expect(body.checks[0]!.detail).toMatch(/orch start/);
    await app.close();
  });

  it('any other failure of the daemon is reported with its message, never thrown', async () => {
    const app = await boot(async () => { throw new Error('boom'); });

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, checks: [{ name: 'daemon', ok: false, detail: expect.stringContaining('boom') }] });
    await app.close();
  });
});
