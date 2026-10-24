import { describe, it, expect, afterEach } from 'vitest';
import fastify, { type FastifyInstance } from 'fastify';
import { jobsRoutes } from '../src/routes/jobs.js';
import { DaemonUnavailableError } from '../src/daemon-proxy.js';

/*
 * POST /api/jobs/import adds the jobs one by one: a refused job does not stop the others (that stays). What was
 * wrong is the report: a refused job came back as `status: 'error'` with nothing else, so a bad `progress` or a bad
 * `resourceLimits` left the user to guess. Every refused job now carries its id and the daemon's exact sentence, the
 * body counts the refusals, and the status is 422 when any job was refused.
 */

const PROGRESS_REFUSAL = 'Invalid progress setting for job "bad-progress": unknown progress strategy "nope" (accepted: auto, off, declared, ratio, log-declared, log-learned, ensemble, history)';
const LIMITS_REFUSAL = 'resourceLimits.cpuPct must be a number between 1 and 100 (got: 500).';

let app: FastifyInstance;

async function build(send: (cmd: string, payload?: unknown) => Promise<unknown>): Promise<FastifyInstance> {
  app = fastify();
  await app.register(jobsRoutes, { proxy: { send }, idleTimer: { reset: () => {} } });
  await app.ready();
  return app;
}

const daemon = async (cmd: string, payload?: unknown): Promise<unknown> => {
  if (cmd !== 'add-job') {
    throw new Error(`Unknown command: ${cmd}`);
  }
  const id = (payload as { id: string }).id;
  if (id === 'bad-progress') {
    throw new Error(PROGRESS_REFUSAL);
  }
  if (id === 'bad-limits') {
    throw new Error(LIMITS_REFUSAL);
  }
  return { id };
};

afterEach(async () => {
  await app.close();
});

describe('POST /api/jobs/import', () => {
  it('imports every valid job and answers 200 with no failure', async () => {
    await build(daemon);
    const res = await app.inject({ method: 'POST', url: '/api/jobs/import', payload: { jobs: [{ id: 'a' }, { id: 'b' }] } });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      imported: 2, failed: 0,
      results: [{ id: 'a', status: 'imported' }, { id: 'b', status: 'imported' }],
    });
  });

  it('reports, for each refused job, its id and the daemon sentence; valid jobs stay imported; the status is 422', async () => {
    await build(daemon);
    const res = await app.inject({
      method: 'POST', url: '/api/jobs/import',
      payload: { jobs: [{ id: 'good-1' }, { id: 'bad-progress', progress: 'nope' }, { id: 'bad-limits' }, { id: 'good-2' }] },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.imported).toBe(2);
    expect(body.failed).toBe(2);
    expect(body.results).toEqual([
      { id: 'good-1', status: 'imported' },
      { id: 'bad-progress', status: 'error', error: PROGRESS_REFUSAL },
      { id: 'bad-limits', status: 'error', error: LIMITS_REFUSAL },
      { id: 'good-2', status: 'imported' },
    ]);
    expect(body.error).toBe('2 of 4 jobs were refused (imported: 2); see results[].error for the reason of each');
  });

  it('a job without an id, or a non-object entry, is a refusal with its position, not a crash', async () => {
    const seen: unknown[] = [];
    await build(async (_cmd, payload) => {
      seen.push(payload);
      throw new Error('Job id must be a non-empty string');
    });
    const res = await app.inject({ method: 'POST', url: '/api/jobs/import', payload: { jobs: [{ command: 'x' }, null, 'text'] } });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.failed).toBe(3);
    expect(body.results.map((r: { id: string }) => r.id)).toEqual(['#1 (no id)', '#2 (no id)', '#3 (no id)']);
    expect(body.results[1].error).toBe('entry is not a job object (got null); expected { "id": ..., "type": ..., "command": ... }');
    expect(body.results[2].error).toBe('entry is not a job object (got string); expected { "id": ..., "type": ..., "command": ... }');
    expect(seen).toHaveLength(1);
  });

  it('a daemon that is down is a 503 for the whole request, not one refusal per job', async () => {
    await build(async () => { throw new DaemonUnavailableError(); });
    const res = await app.inject({ method: 'POST', url: '/api/jobs/import', payload: { jobs: [{ id: 'a' }] } });

    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toEqual({ error: 'daemon-not-running' });
  });

  it('refuses a payload that is not { jobs: [] } with the expected shape', async () => {
    await build(daemon);
    const res = await app.inject({ method: 'POST', url: '/api/jobs/import', payload: { jobs: 'nope' } });

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid-payload: expected { jobs: [] }');
  });
});
