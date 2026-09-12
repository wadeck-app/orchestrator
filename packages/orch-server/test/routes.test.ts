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
