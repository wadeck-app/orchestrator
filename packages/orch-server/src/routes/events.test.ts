import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import Fastify from 'fastify';
import { eventsRoute } from './events.js';
import { IdleTimer } from '../idle-timer.js';
import type { DaemonProxy } from '../daemon-proxy.js';

function makeProxy(stateResult: unknown = {}): DaemonProxy {
  return {
    send: vi.fn().mockResolvedValue(stateResult),
  } as unknown as DaemonProxy;
}

function makeIdleTimer(): IdleTimer {
  return {
    addSseConnection: vi.fn(),
    removeSseConnection: vi.fn(),
    reset: vi.fn(),
    stop: vi.fn(),
  } as unknown as IdleTimer;
}

function sseRequest(port: number): Promise<{ headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const collected: string[] = [];
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/api/events', method: 'GET' },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          collected.push(chunk.toString());
          // Close after receiving any data (we just need the first chunk)
          if (collected.join('').includes('\n\n')) {
            res.destroy();
          }
        });
        res.on('close', () => resolve({ headers: res.headers, body: collected.join('') }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('eventsRoute', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('responds with Content-Type text/event-stream and initial connected event', async () => {
    const app = Fastify();
    const proxy = makeProxy({});
    const idleTimer = makeIdleTimer();
    await app.register(eventsRoute, { proxy, idleTimer });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    try {
      const { headers, body } = await sseRequest(port);
      expect(headers['content-type']).toBe('text/event-stream');
      expect(body).toContain('event: connected');
      expect(body).toContain('data: {}');
    } finally {
      await app.close();
    }
  });

  it('calls idleTimer.addSseConnection on connect', async () => {
    const app = Fastify();
    const proxy = makeProxy({});
    const idleTimer = makeIdleTimer();
    await app.register(eventsRoute, { proxy, idleTimer });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    try {
      await sseRequest(port);
      expect(idleTimer.addSseConnection).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('calls idleTimer.removeSseConnection after client disconnects', async () => {
    const app = Fastify();
    const proxy = makeProxy({});
    const idleTimer = makeIdleTimer();
    await app.register(eventsRoute, { proxy, idleTimer });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    try {
      await sseRequest(port);
      // Wait for close event to propagate
      await new Promise(r => setTimeout(r, 50));
      expect(idleTimer.removeSseConnection).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('polls proxy.send("list-state") and emits state event', async () => {
    const state = { 'job-1': { startedAt: '2026-09-01T00:00:00Z', exitCode: 0, pid: 1 } };
    const proxy = makeProxy(state);
    const idleTimer = makeIdleTimer();

    const app = Fastify();
    // Use 80ms poll interval so the test completes quickly with real timers
    await app.register(eventsRoute, { proxy, idleTimer, pollIntervalMs: 80 });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as { port: number };

    const collected: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { hostname: '127.0.0.1', port, path: '/api/events', method: 'GET' },
        (res) => {
          res.on('data', (chunk: Buffer) => {
            collected.push(chunk.toString());
            if (collected.join('').includes('event: state')) {
              res.destroy();
              resolve();
            }
          });
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.end();
    });

    expect(proxy.send).toHaveBeenCalledWith('list-state');
    expect(collected.join('')).toContain('event: state');

    await app.close();
  }, 3000);
});
