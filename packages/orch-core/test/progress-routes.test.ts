import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { jobsRoutes } from '../src/routes/jobs.js';
import { DaemonUnavailableError } from '../src/daemon-proxy.js';

type Send = (cmd: string, payload?: unknown) => Promise<unknown>;

const ESTIMATE = {
  strategyId: 'history', progress: 0.42, etaAt: '2026-10-20T14:32:00.000Z', confidence: 'high', confidenceScore: 0.9,
  reason: 'auto: history', serverNow: '2026-10-20T14:00:00.000Z',
};

describe('progress in the jobs routes', () => {
  let app: FastifyInstance;
  let send: Send;
  let calls: Array<[string, unknown]>;

  beforeEach(async () => {
    calls = [];
    send = async (cmd, payload) => {
      calls.push([cmd, payload]);
      switch (cmd) {
        case 'list-jobs': return [{ id: 'run', type: 'cron' }, { id: 'idle', type: 'cron' }];
        case 'list-state': return {
          run: [{ startedAt: '2026-10-20T13:50:00Z', exitCode: null }],
          idle: [{ startedAt: '2026-10-20T12:00:00Z', finishedAt: '2026-10-20T12:10:00Z', exitCode: 0 }],
        };
        case 'get-uptime': return {};
        case 'get-job': return { id: (payload as { id: string }).id, type: 'cron' };
        case 'get-progress': return { run: ESTIMATE };
        default: throw new Error(`Unknown command: ${cmd}`);
      }
    };
    app = fastify();
    await app.register(jobsRoutes, { proxy: { send: (c: string, p?: unknown) => send(c, p) } as never, idleTimer: { reset: () => {} } });
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  describe('GET /api/jobs', () => {
    it('adds the estimate of a running job and null for the others', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/jobs' })).json();
      expect(body.find((r: { job: { id: string } }) => r.job.id === 'run').progress).toEqual(ESTIMATE);
      expect(body.find((r: { job: { id: string } }) => r.job.id === 'idle').progress).toBeNull();
    });

    it('turns a failing get-progress into an estimate that says so, for running jobs only', async () => {
      const base = send;
      send = async (cmd, payload) => {
        if (cmd === 'get-progress') { throw new Error('Unknown command: get-progress'); }
        return base(cmd, payload);
      };
      const res = await app.inject({ method: 'GET', url: '/api/jobs' });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const run = body.find((r: { job: { id: string } }) => r.job.id === 'run').progress;
      expect(run).toMatchObject({ strategyId: null, progress: null, etaAt: null, confidence: 'none' });
      expect(run.reason).toMatch(/^progress unavailable: Unknown command: get-progress/);
      expect(Number.isNaN(Date.parse(run.serverNow))).toBe(false);
      expect(body.find((r: { job: { id: string } }) => r.job.id === 'idle').progress).toBeNull();
    });

    it('still answers 503 when the daemon is down', async () => {
      send = async () => { throw new DaemonUnavailableError(); };
      expect((await app.inject({ method: 'GET', url: '/api/jobs' })).statusCode).toBe(503);
    });
  });

  describe('GET /api/jobs/:id', () => {
    it('adds the estimate, asking the daemon for that job only', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/jobs/run' })).json();
      expect(body.progress).toEqual(ESTIMATE);
      expect(calls).toContainEqual(['get-progress', { jobIds: ['run'] }]);
    });

    it('has progress null for a job that is not running', async () => {
      const body = (await app.inject({ method: 'GET', url: '/api/jobs/idle' })).json();
      expect(body.progress).toBeNull();
    });

    it('turns a failing get-progress into an estimate that says so', async () => {
      const base = send;
      send = async (cmd, payload) => {
        if (cmd === 'get-progress') { throw new Error('boom'); }
        return base(cmd, payload);
      };
      const res = await app.inject({ method: 'GET', url: '/api/jobs/run' });
      expect(res.statusCode).toBe(200);
      expect(res.json().progress.reason).toMatch(/^progress unavailable: boom/);
    });
  });

  describe('GET /api/jobs/:id/progress', () => {
    it('returns the estimate', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/jobs/run/progress' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ESTIMATE);
      expect(calls).toContainEqual(['get-progress', { jobIds: ['run'] }]);
    });

    it('returns null for a job without an open run', async () => {
      send = async () => ({});
      const res = await app.inject({ method: 'GET', url: '/api/jobs/idle/progress' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBeNull();
    });

    it('answers 404 with the daemon sentence for an unknown job', async () => {
      send = async () => { throw new Error('Job not found: "ghost". Run `orch list` to see the available job ids.'); };
      const res = await app.inject({ method: 'GET', url: '/api/jobs/ghost/progress' });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/^Job not found: "ghost"/);
    });

    it('returns an estimate that says so when the daemon cannot compute it', async () => {
      send = async () => { throw new Error('boom'); };
      const res = await app.inject({ method: 'GET', url: '/api/jobs/run/progress' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ progress: null, confidence: 'none' });
      expect(res.json().reason).toMatch(/^progress unavailable: boom/);
    });

    it('answers 503 when the daemon is down', async () => {
      send = async () => { throw new DaemonUnavailableError(); };
      expect((await app.inject({ method: 'GET', url: '/api/jobs/run/progress' })).statusCode).toBe(503);
    });
  });
});
