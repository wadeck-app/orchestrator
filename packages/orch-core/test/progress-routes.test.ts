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

describe('progress in the jobs routes: odd failures', () => {
  let app: FastifyInstance;
  let send: Send;
  let calls: Array<[string, unknown]>;

  beforeEach(async () => {
    calls = [];
    send = async (cmd, payload) => {
      calls.push([cmd, payload]);
      switch (cmd) {
        case 'list-jobs': return [{ id: 'run', type: 'cron' }];
        case 'list-state': return { run: [{ startedAt: '2026-10-20T13:50:00Z', exitCode: null }] };
        case 'get-uptime': return {};
        case 'get-job': return { id: 'run', type: 'cron' };
        case 'get-progress': return { run: ESTIMATE };
        default: throw new Error(`Unknown command: ${cmd}`);
      }
    };
    app = fastify();
    await app.register(jobsRoutes, { proxy: { send: (c: string, p?: unknown) => send(c, p) } as never, idleTimer: { reset: () => {} } });
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  const failWith = (thrown: unknown): void => {
    const base = send;
    send = async (cmd, payload) => {
      if (cmd === 'get-progress') { throw thrown; }
      return base(cmd, payload);
    };
  };

  it('says why when get-progress throws something that is not an Error (a string)', async () => {
    failWith('plain string failure');
    const res = await app.inject({ method: 'GET', url: '/api/jobs/run/progress' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toMatch(/^progress unavailable: plain string failure\. Check: orch logs/);
  });

  it('says why when get-progress throws undefined, in the job list too', async () => {
    failWith(undefined);
    const body = (await app.inject({ method: 'GET', url: '/api/jobs' })).json();
    expect(body[0].progress.reason).toMatch(/^progress unavailable: undefined\. Check: orch logs/);
    expect(body[0].progress).toMatchObject({ progress: null, confidence: 'none', strategyId: null });
  });

  it('the list shows null, not an error, when the daemon answers get-progress with null', async () => {
    const base = send;
    send = async (cmd, payload) => (cmd === 'get-progress' ? null : base(cmd, payload));
    const res = await app.inject({ method: 'GET', url: '/api/jobs' });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0].progress).toBeNull();
  });

  it('the detail shows null when the daemon answers get-progress with null', async () => {
    const base = send;
    send = async (cmd, payload) => (cmd === 'get-progress' ? null : base(cmd, payload));
    const res = await app.inject({ method: 'GET', url: '/api/jobs/run' });
    expect(res.statusCode).toBe(200);
    expect(res.json().progress).toBeNull();
  });

  it('the progress route answers null when the daemon answers null', async () => {
    send = async () => null;
    const res = await app.inject({ method: 'GET', url: '/api/jobs/run/progress' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });

  it('a daemon refusal that is not "Job not found" is an estimate that says so, not a 400', async () => {
    failWith(new Error('get-progress: jobIds must be an array of job ids, or omitted for every running job.'));
    const res = await app.inject({ method: 'GET', url: '/api/jobs/run/progress' });
    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toMatch(/jobIds must be an array/);
  });

  it('asks the list for every running job (no payload) and the detail for its own', async () => {
    await app.inject({ method: 'GET', url: '/api/jobs' });
    await app.inject({ method: 'GET', url: '/api/jobs/run' });
    expect(calls.filter(([c]) => c === 'get-progress')).toEqual([
      ['get-progress', undefined],
      ['get-progress', { jobIds: ['run'] }],
    ]);
  });

  it('the detail route is 503 when the daemon goes down while asking for progress', async () => {
    failWith(new DaemonUnavailableError());
    expect((await app.inject({ method: 'GET', url: '/api/jobs/run' })).statusCode).toBe(503);
  });
});
