import { describe, it, beforeEach, afterEach } from 'vitest';
import { expect } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fastify from 'fastify';
import { jobsRoutes } from '../src/routes/jobs.js';
import { DaemonProxy, DaemonUnavailableError } from '../src/daemon-proxy.js';
import type { IdleSignal } from '../src/route-host.js';

/**
 * The edit-job payload these tests assert on.
 *
 * Named rather than `Record<string, unknown>`: the fields ARE the daemon contract this suite
 * exists to pin down -- `{ id, updates, unset }` and specifically NOT a flattened body -- so
 * spelling them out is what makes a wrong shape a type error rather than an undefined lookup.
 */
interface EditJobPayload {
  id?: string;
  updates?: unknown;
  unset?: unknown;
  command?: unknown;
  label?: unknown;
}

describe('Jobs API Routes', () => {
  let app: FastifyInstance;
  let mockProxy: Pick<DaemonProxy, 'send'>;
  let idleTimer: Pick<IdleSignal, 'reset'>;

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
            if ((payload as { id?: string })?.id === 'job1') {
              return { id: 'job1', type: 'cron', command: 'echo 1' };
            }
            throw new Error('Job not found');
          case 'add-job':
            return { id: 'new-job', type: 'cron', command: 'echo new' };
          case 'edit-job':
            return { id: (payload as { id?: string })?.id, command: 'updated' };
          case 'remove-job':
            return { removed: true };
          case 'trigger-job':
            return { triggered: true };
          case 'skip-next-firing':
            return { skipped: true };
          case 'kill-job':
            if ((payload as { id?: string })?.id === 'job1') {
              return { killed: true };
            }
            return { killed: false };
          default:
            throw new Error(`Unknown command: ${cmd}`);
        }
      },
    };

    idleTimer = {
      reset: () => {},
    };

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
        throw new DaemonUnavailableError();
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
      let sent: EditJobPayload | undefined;
      mockProxy.send = async (cmd, payload) => {
        if (cmd === 'edit-job') {
          sent = payload as EditJobPayload;
        }
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
      let sent: EditJobPayload | undefined;
      mockProxy.send = async (cmd, payload) => {
        if (cmd === 'edit-job') {
          sent = payload as EditJobPayload;
        }
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
      let sent: EditJobPayload | undefined;
      mockProxy.send = async (cmd, payload) => {
        if (cmd === 'edit-job') {
          sent = payload as EditJobPayload;
        }
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

  // A trigger the daemon refuses because the job is at its concurrency limit is an outcome, not an
  // error: 200 with the status in the body, so a client can say "already running" instead of
  // reporting a failure or, worse, a success.
  describe('a trigger refused by the concurrency limit', () => {
    const REFUSED = { status: 'already-running', running: 1, maxConcurrency: 1 };

    function stubDaemon(sent: Array<{ cmd: string; payload: any }>): void {
      mockProxy.send = async (cmd: string, payload?: unknown) => {
        sent.push({ cmd, payload });
        return cmd === 'trigger-job' ? REFUSED : { skipped: true };
      };
    }

    it('answers 200 with the status instead of 204', async () => {
      stubDaemon([]);

      const res = await app.inject({ method: 'POST', url: '/api/jobs/job1/trigger' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(REFUSED);
    });

    it('passes force=true through to the daemon', async () => {
      const sent: Array<{ cmd: string; payload: any }> = [];
      stubDaemon(sent);

      await app.inject({ method: 'POST', url: '/api/jobs/job1/trigger?force=true' });

      expect(sent.find(s => s.cmd === 'trigger-job')?.payload.force).toBe(true);
    });

    it('does not force by default', async () => {
      const sent: Array<{ cmd: string; payload: any }> = [];
      stubDaemon(sent);

      await app.inject({ method: 'POST', url: '/api/jobs/job1/trigger' });

      expect(sent.find(s => s.cmd === 'trigger-job')?.payload.force).toBeFalsy();
    });

    // Skipping the next firing is what "run it early" means once it ran. Nothing ran here, so the
    // scheduled firing is still owed.
    it('trigger-early does not skip the next firing when nothing was started', async () => {
      const sent: Array<{ cmd: string; payload: any }> = [];
      stubDaemon(sent);

      const res = await app.inject({ method: 'POST', url: '/api/jobs/job1/trigger-early' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(REFUSED);
      expect(sent.map(s => s.cmd)).not.toContain('skip-next-firing');
    });

    it('a started trigger still answers 204', async () => {
      mockProxy.send = async () => ({ status: 'started', pid: 42 });

      const res = await app.inject({ method: 'POST', url: '/api/jobs/job1/trigger' });

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
        throw new DaemonUnavailableError();
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
        if (cmd === 'list-jobs') {
          return [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
        }
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
    };
    await app.register(jobsRoutes, { proxy, idleTimer: { reset: () => {} } });
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

// With several instances alive the newest run can have ended while an older one is still going.
// Reading only the newest said the job was idle: "ok" while a process was running.
describe('GET /api/health with several instances of one job', () => {
  async function healthFor(history: unknown[]): Promise<{ runningJobs: number; status: string }> {
    const app = fastify();
    const proxy = {
      send: async (cmd: string) => {
        if (cmd === 'list-jobs') {
          return [{ id: 'a' }];
        }
        if (cmd === 'list-state') {
          return { a: history };
        }
        throw new Error(`Unknown command: ${cmd}`);
      },
    };
    await app.register(jobsRoutes, { proxy, idleTimer: { reset: () => {} } });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    return res.json();
  }

  it('counts the job as running while an older instance is alive', async () => {
    const body = await healthFor([
      { startedAt: '2026-01-01T00:05:00Z', exitCode: 0, finishedAt: '2026-01-01T00:05:30Z' },
      { startedAt: '2026-01-01T00:00:00Z', exitCode: null },
    ]);

    expect(body.runningJobs).toBe(1);
    expect(body.status).toBe('busy');
  });

  it('counts a job once however many instances are alive', async () => {
    const body = await healthFor([
      { startedAt: '2026-01-01T00:05:00Z', exitCode: null },
      { startedAt: '2026-01-01T00:00:00Z', exitCode: null },
    ]);

    expect(body.runningJobs).toBe(1);
  });

  it('still reads idle when every run has ended', async () => {
    const body = await healthFor([
      { startedAt: '2026-01-01T00:05:00Z', exitCode: 0, finishedAt: '2026-01-01T00:05:30Z' },
      { startedAt: '2026-01-01T00:00:00Z', exitCode: 0, finishedAt: '2026-01-01T00:00:30Z' },
    ]);

    expect(body.runningJobs).toBe(0);
    expect(body.status).toBe('ok');
  });
});

// The daemon's own rule (isFailure in orchestrator-cli/src/state.ts): a skipped run is neither a success
// nor a failure even though it keeps the child's real exit code. A run the user ended is not a fault either.
describe('GET /api/health failure rule', () => {
  async function healthFor(history: unknown[]): Promise<{ recentFailures: number; status: string }> {
    const app = fastify();
    const proxy = {
      send: async (cmd: string) => {
        if (cmd === 'list-jobs') {
          return [{ id: 'a' }];
        }
        if (cmd === 'list-state') {
          return { a: history };
        }
        throw new Error(`Unknown command: ${cmd}`);
      },
    };
    await app.register(jobsRoutes, { proxy, idleTimer: { reset: () => {} } });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();
    return res.json();
  }

  const done = { startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:01Z' };

  it('does not count a run skipped by skipExitCodes, although it keeps its real exit code', async () => {
    const body = await healthFor([{ ...done, exitCode: 2, skipped: true }]);
    expect(body.recentFailures).toBe(0);
    expect(body.status).toBe('ok');
  });

  it('does not count a run the user cancelled, even with a non-zero exit code', async () => {
    const body = await healthFor([{ ...done, exitCode: 143, cancelledByUser: true }]);
    expect(body.recentFailures).toBe(0);
    expect(body.status).toBe('ok');
  });

  it('still counts a real failure', async () => {
    const body = await healthFor([{ ...done, exitCode: 2 }]);
    expect(body.recentFailures).toBe(1);
    expect(body.status).toBe('degraded');
  });
});

describe('GET /api/jobs/:jobId/telemetry', () => {
  let app: FastifyInstance;
  let sent: Array<{ cmd: string; payload: unknown }>;
  let send: (cmd: string, payload?: unknown) => Promise<unknown>;

  beforeEach(async () => {
    app = fastify();
    sent = [];
    send = async (cmd, payload) => {
      sent.push({ cmd, payload });
      if (cmd === 'get-run-telemetry') {
        return { run: '2026-01-01T00:00:00Z', available: true, samples: [] };
      }
      throw new Error(`Unknown command: ${cmd}`);
    };
    await app.register(jobsRoutes, { proxy: { send: (cmd: string, payload?: unknown) => send(cmd, payload) }, idleTimer: { reset: () => {} } });
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it('asks the daemon for the newest run when no run is given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/job1/telemetry' });
    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(true);
    expect(sent).toEqual([{ cmd: 'get-run-telemetry', payload: { jobId: 'job1' } }]);
  });

  it('passes the run asked for', async () => {
    await app.inject({ method: 'GET', url: `/api/jobs/job1/telemetry?run=${encodeURIComponent('2026-01-01T00:00:00Z')}` });
    expect(sent).toEqual([{ cmd: 'get-run-telemetry', payload: { jobId: 'job1', run: '2026-01-01T00:00:00Z' } }]);
  });

  it('refuses a repeated or empty run with a 400 that says what to send, and does not bother the daemon', async () => {
    const twice = await app.inject({ method: 'GET', url: '/api/jobs/job1/telemetry?run=a&run=b' });
    const empty = await app.inject({ method: 'GET', url: '/api/jobs/job1/telemetry?run=' });
    expect(twice.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(twice.json().error).toMatch(/run must be/);
    expect(sent).toEqual([]);
  });

  it('returns 503 when the daemon is not running, like its neighbours', async () => {
    send = async () => { throw new DaemonUnavailableError(); };
    const res = await app.inject({ method: 'GET', url: '/api/jobs/job1/telemetry' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('daemon-not-running');
  });

  it('lets the daemon refusing the id surface as an error, not as an empty success', async () => {
    send = async () => { throw new Error('Job not found: "ghost"'); };
    const res = await app.inject({ method: 'GET', url: '/api/jobs/ghost/telemetry' });
    expect(res.statusCode).toBe(500);
  });

  it('is not swallowed by the neighbouring /api/jobs/:id and /api/jobs/export routes, whatever their order', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/jobs/export' });
    expect(res.statusCode).toBe(500);
    // export asks for list-jobs; had :id taken it, the daemon would have been asked get-job.
    expect(sent.map(s => s.cmd)).toEqual(['list-jobs']);
  });
});

// /api/health used to report the dashboard server's own process uptime, which restarts whenever the server idles
// out and says nothing about the daemon. It now carries the daemon's, from get-daemon-info.
describe('GET /api/health uptime and GET /api/daemon', () => {
  const daemonInfo = {
    version: '1.2.3', pid: 42, port: 47900, startedAt: '2026-01-01T00:00:00.000Z', uptimeSeconds: 1234,
    config: {}, supervisor: { requested: true, active: true },
    runs: { running: 0, supervised: 0, followedAgain: 0 }, scheduler: { armed: 0, desired: 0, problems: [] },
  };

  async function appWith(send: (cmd: string) => Promise<unknown>): Promise<FastifyInstance> {
    const app = fastify();
    await app.register(jobsRoutes, { proxy: { send }, idleTimer: { reset: () => {} } });
    await app.ready();
    return app;
  }

  const base = async (cmd: string): Promise<unknown> => {
    if (cmd === 'list-jobs') {
      return [];
    }
    if (cmd === 'list-state') {
      return {};
    }
    throw new Error(`Unknown command: ${cmd}`);
  };

  it('reports the daemon uptime, not the dashboard server process uptime', async () => {
    const app = await appWith(async (cmd) => (cmd === 'get-daemon-info' ? daemonInfo : base(cmd)));
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().uptime).toBe(1234);
  });

  it('still answers health, with a null uptime, when the daemon cannot say its info', async () => {
    const app = await appWith(async (cmd) => {
      if (cmd === 'get-daemon-info') {
        throw new Error('Unknown command: get-daemon-info');
      }
      return base(cmd);
    });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().uptime).toBeNull();
    expect(res.json().status).toBe('ok');
  });

  it('GET /api/daemon returns the daemon reply as is', async () => {
    const app = await appWith(async (cmd) => (cmd === 'get-daemon-info' ? daemonInfo : base(cmd)));
    const res = await app.inject({ method: 'GET', url: '/api/daemon' });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(daemonInfo);
  });

  it('GET /api/daemon answers 503 daemon-not-running when the daemon is down', async () => {
    const app = await appWith(async () => { throw new DaemonUnavailableError(); });
    const res = await app.inject({ method: 'GET', url: '/api/daemon' });
    await app.close();

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'daemon-not-running' });
  });
});
