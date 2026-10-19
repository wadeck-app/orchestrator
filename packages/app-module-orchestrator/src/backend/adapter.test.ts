import { describe, expect, it, vi } from 'vitest';
import type { ModuleRouteHandler } from '@wadeck-app/app-core-sdk';
import { createRouteAdapter } from './adapter.js';

/*
 * orch-core's route files register themselves on a Fastify instance (`fastify.get(path, handler)`).
 * A module has no Fastify instance, only `ctx.registerRoute(method, subPath, handler)`. The adapter
 * is the thin shim that lets those same route files run unchanged, and the allow-list is what keeps
 * the routes a dashboard UI does not need (secrets, exec) from being published by a module.
 */
// Typed loosely on purpose: the SDK's ModuleRouteHandler changes between versions, and the adapter only passes it through.
const handler = (() => undefined) as never;

function fakeCtx() {
  return { registerRoute: vi.fn<(method: string, subPath: string, h: ModuleRouteHandler) => void>() };
}

describe('createRouteAdapter', () => {
  it('forwards an allowed route with an upper-case method and the same handler', () => {
    const ctx = fakeCtx();
    const { app } = createRouteAdapter(ctx, ['GET /api/jobs', 'POST /api/jobs/:id/kill', 'PUT /api/jobs/:id', 'DELETE /api/jobs/:id']);

    app.get('/api/jobs', handler);
    app.post('/api/jobs/:id/kill', handler);
    app.put('/api/jobs/:id', handler);
    app.delete('/api/jobs/:id', handler);

    expect(ctx.registerRoute.mock.calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /api/jobs', 'POST /api/jobs/:id/kill', 'PUT /api/jobs/:id', 'DELETE /api/jobs/:id',
    ]);
    expect(ctx.registerRoute.mock.calls[0]?.[2]).toBe(handler);
  });

  it('refuses a route registered twice instead of passing both to the host', () => {
    const ctx = fakeCtx();
    const { app } = createRouteAdapter(ctx, ['GET /api/jobs/:jobId/telemetry']);

    app.get('/api/jobs/:jobId/telemetry', handler);

    expect(() => app.get('/api/jobs/:jobId/telemetry', handler)).toThrow(/registered twice/);
    expect(ctx.registerRoute).toHaveBeenCalledTimes(1);
  });

  it('accepts the (path, options, handler) form Fastify also allows', () => {
    const ctx = fakeCtx();
    const { app } = createRouteAdapter(ctx, ['GET /api/jobs']);

    // The route files only use the two-argument form; the shim tolerates Fastify's three-argument one anyway.
    (app.get as (...args: unknown[]) => unknown)('/api/jobs', { schema: {} }, handler);

    expect(ctx.registerRoute).toHaveBeenCalledWith('GET', '/api/jobs', handler);
  });

  it('does not publish a route that is not allowed, and reports it as skipped', () => {
    const ctx = fakeCtx();
    const { app, skipped } = createRouteAdapter(ctx, ['GET /api/jobs']);

    app.get('/api/secrets', handler);
    app.post('/api/exec', handler);

    expect(ctx.registerRoute).not.toHaveBeenCalled();
    expect(skipped).toEqual(['GET /api/secrets', 'POST /api/exec']);
  });

  it('treats the method as part of the route: an allowed path with another method is skipped', () => {
    const ctx = fakeCtx();
    const { app, skipped } = createRouteAdapter(ctx, ['GET /api/jobs']);

    app.post('/api/jobs', handler);

    expect(ctx.registerRoute).not.toHaveBeenCalled();
    expect(skipped).toEqual(['POST /api/jobs']);
  });

  it('fails loudly on any Fastify API a module cannot honour, instead of silently doing nothing', () => {
    const { app } = createRouteAdapter(fakeCtx(), []);
    const unsupported = app as unknown as Record<string, () => void>;

    expect(() => unsupported['addHook']?.()).toThrow(/addHook.*not supported/i);
    expect(() => unsupported['register']?.()).toThrow(/register.*not supported/i);
  });

  describe('assertAllRegistered', () => {
    it('passes when every allowed route was registered', () => {
      const { app, assertAllRegistered } = createRouteAdapter(fakeCtx(), ['GET /api/jobs']);
      app.get('/api/jobs', handler);
      expect(() => assertAllRegistered()).not.toThrow();
    });

    it('names the allowed routes the route files no longer register, so an upstream rename cannot go unnoticed', () => {
      const { app, assertAllRegistered } = createRouteAdapter(fakeCtx(), ['GET /api/jobs', 'GET /api/schedule', 'POST /api/jobs/:id/kill']);
      app.get('/api/jobs', handler);

      expect(() => assertAllRegistered()).toThrow(/GET \/api\/schedule[\s\S]*POST \/api\/jobs\/:id\/kill/);
    });
  });
});
