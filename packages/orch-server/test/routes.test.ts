import { describe, it, beforeEach, afterEach } from 'vitest';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import { jobsRoutes } from '../src/routes/jobs.js';
import { DaemonProxy, DaemonUnavailableError } from '../src/daemon-proxy.js';
import { IdleTimer } from '../src/idle-timer.js';

describe('Jobs API Routes', () => {
  let app: FastifyInstance;
  let mockProxy: DaemonProxy;
  let idleTimer: IdleTimer;

  beforeEach(async () => {
    app = fastify();

    // Mock DaemonProxy
    mockProxy = {
      send: async (cmd: string, payload?: unknown) => {
        switch (cmd) {
          case 'list-jobs':
            return [
              { id: 'job1', type: 'cron', command: 'echo 1' },
              { id: 'job2', type: 'startup', command: 'echo 2' },
            ];
          case 'list-state':
            return {
              job1: [{ startedAt: '2026-01-01T00:00:00Z', exitCode: 0 }],
              job2: [],
            };
          case 'get-uptime':
            return { job1: 99.5, job2: 100 };
          case 'get-job':
            if ((payload as any)?.id === 'job1') {
              return { id: 'job1', type: 'cron', command: 'echo 1' };
            }
            throw new Error('Job not found');
          case 'add-job':
            return { id: 'new-job', type: 'cron', command: 'echo new' };
          case 'edit-job':
            return { id: (payload as any)?.id, command: 'updated' };
          case 'remove-job':
            return { removed: true };
          case 'trigger-job':
            return { triggered: true };
          case 'skip-next-firing':
            return { skipped: true };
          case 'kill-job':
            if ((payload as any)?.id === 'job1') {
              return { killed: true };
            }
            return { killed: false };
          default:
            throw new Error(`Unknown command: ${cmd}`);
        }
      },
    } as any;

    idleTimer = {
      reset: () => {},
    } as any;

    await app.register(jobsRoutes, { proxy: mockProxy, idleTimer });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('GET /api/jobs', () => {
    it('returns all jobs with run history', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/jobs',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBe(2);
      expect(body[0].job.id).toBe('job1');
      expect(body[0].runHistory).toBeDefined();
    });

    it('returns 503 when daemon is unavailable', async () => {
      mockProxy.send = async () => {
        throw new DaemonUnavailableError('Daemon down');
      };

      const res = await app.inject({
        method: 'GET',
        url: '/api/jobs',
      });

      expect(res.statusCode).toBe(503);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('daemon-not-running');
    });
  });

  describe('GET /api/jobs/:id', () => {
    it('returns specific job detail', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/jobs/job1',
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.job.id).toBe('job1');
      expect(body.runHistory).toBeDefined();
    });

    it('returns 500 if job not found', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/jobs/nonexistent',
      });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('POST /api/jobs', () => {
    it('creates new job and returns 201', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { id: 'new-job', type: 'cron', command: 'echo new', schedule: '0 * * * *' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('new-job');
    });

    it('returns 400 if payload invalid', async () => {
      mockProxy.send = async () => {
        throw new Error('Invalid job');
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs',
        payload: { /* invalid */ },
      });

      expect(res.statusCode).toBe(500);
    });
  });

  describe('PUT /api/jobs/:id', () => {
    it('updates job and returns updated object', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/jobs/job1',
        payload: { command: 'updated' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe('job1');
    });

    // The route flattened the body into the payload, so the daemon's edit-job -- which reads
    // { id, updates } -- got updates: undefined and threw "Cannot convert undefined or null to
    // object". Saving from the web UI did nothing at all. The test above passed throughout, because
    // the mock answers whatever it is sent: it exercised the route, never the contract.
    it('sends the body as `updates`, the shape the daemon actually reads', async () => {
      let sent: Record<string, unknown> | undefined;
      (mockProxy as unknown as { send: DaemonProxy['send'] }).send = async (cmd, payload) => {
        if (cmd === 'edit-job') sent = payload as Record<string, unknown>;
        return { id: 'job1', command: 'updated' };
      };

      const res = await app.inject({
        method: 'PUT',
        url: '/api/jobs/job1',
        payload: { command: 'updated', label: 'Renamed' },
      });

      expect(res.statusCode).toBe(200);
      expect(sent).toBeDefined();
      expect(sent!.id).toBe('job1');
      expect(sent!.updates).toEqual({ command: 'updated', label: 'Renamed' });
      // Flattened fields would leave `updates` undefined, which is exactly the bug.
      expect(sent!.command).toBeUndefined();
      expect(sent!.label).toBeUndefined();
    });

    // edit-job is a patch, so an omitted field means "leave it alone" -- a client clearing the
    // working directory has to say so out loud. `unset` travels beside `updates`, never inside it:
    // inside, the daemon would take it for a job field and validation would reject the whole edit.
    it('lifts `unset` out of the body and passes it beside `updates`', async () => {
      let sent: Record<string, unknown> | undefined;
      (mockProxy as unknown as { send: DaemonProxy['send'] }).send = async (cmd, payload) => {
        if (cmd === 'edit-job') sent = payload as Record<string, unknown>;
        return { id: 'job1' };
      };

      const res = await app.inject({
        method: 'PUT',
        url: '/api/jobs/job1',
        payload: { label: 'Renamed', unset: ['cwd'] },
      });

      expect(res.statusCode).toBe(200);
      expect(sent!.unset).toEqual(['cwd']);
      expect(sent!.updates).toEqual({ label: 'Renamed' });
    });

    it('sends no `unset` when the body has none', async () => {
      let sent: Record<string, unknown> | undefined;
      (mockProxy as unknown as { send: DaemonProxy['send'] }).send = async (cmd, payload) => {
        if (cmd === 'edit-job') sent = payload as Record<string, unknown>;
        return { id: 'job1' };
      };

      await app.inject({ method: 'PUT', url: '/api/jobs/job1', payload: { label: 'Renamed' } });

      expect(sent!.unset).toBeUndefined();
    });
  });

  describe('DELETE /api/jobs/:id', () => {
    it('deletes job and returns 204 No Content', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/jobs/job1',
      });

      expect(res.statusCode).toBe(204);
      expect(res.body).toBe('');
    });
  });

  describe('POST /api/jobs/:id/trigger', () => {
    it('triggers job and returns 204', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/job1/trigger',
      });

      expect(res.statusCode).toBe(204);
    });

    it('passes IP and User-Agent to proxy', async () => {
      let capturedPayload: any = null;
      mockProxy.send = async (cmd: string, payload?: unknown) => {
        if (cmd === 'trigger-job') {
          capturedPayload = payload;
        }
        return { triggered: true };
      };

      await app.inject({
        method: 'POST',
        url: '/api/jobs/job1/trigger',
        headers: {
          'user-agent': 'test-client/1.0',
        },
      });

      expect(capturedPayload).toBeDefined();
      expect(capturedPayload.id).toBe('job1');
      expect(capturedPayload.userAgent).toBe('test-client/1.0');
    });
  });

  describe('POST /api/jobs/:id/trigger-early', () => {
    it('triggers and skips next firing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/job1/trigger-early',
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /api/jobs/:id/kill', () => {
    it('kills running job and returns 204', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/job1/kill',
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 if job not running/killable', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/job2/kill',
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 503 when daemon unavailable', async () => {
      mockProxy.send = async () => {
        throw new DaemonUnavailableError('Daemon down');
      };

      const res = await app.inject({
        method: 'POST',
        url: '/api/jobs/job1/kill',
      });

      expect(res.statusCode).toBe(503);
    });
  });
});

describe('GET /api/health counting', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = fastify();
    const proxy = {
      send: async (cmd: string) => {
        if (cmd === 'list-jobs') return [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        if (cmd === 'list-state') {
          return {
            // In flight: no finishedAt.
            a: [{ startedAt: '2026-01-01T00:00:10Z', exitCode: null }],
            // Killed by signal: no exit code but finished -- must not count as running.
            b: [{ startedAt: '2026-01-01T00:00:00Z', exitCode: null, finishedAt: '2026-01-01T00:00:05Z' }],
            // Never run: must not count as a failure.
            c: [],
            // Out of order on purpose: the newest run failed.
            d: [
              { startedAt: '2026-01-01T00:00:00Z', exitCode: 0, finishedAt: '2026-01-01T00:00:01Z' },
              { startedAt: '2026-01-01T00:00:20Z', exitCode: 3, finishedAt: '2026-01-01T00:00:21Z' },
            ],
          };
        }
        throw new Error(`Unknown command: ${cmd}`);
      },
    } as any;
    await app.register(jobsRoutes, { proxy, idleTimer: { reset: () => {} } as any });
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it('counts only in-flight runs as running and only real non-zero exits as failures', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.runningJobs).toBe(1);
    expect(body.recentFailures).toBe(1);
    expect(body.status).toBe('degraded');
  });
});
