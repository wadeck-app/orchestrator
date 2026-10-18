import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jobsRoutes } from './jobs.js';

/*
 * POST /api/failures/ack used to ignore its body and acknowledge every failure, so the per-job button of
 * the failure notifications dismissed failures nobody had looked at. A job id in the body now narrows it.
 */
describe('POST /api/failures/ack', () => {
  let app: FastifyInstance;
  let sent: Array<{ command: string; payload: unknown }>;

  beforeEach(async () => {
    app = fastify();
    sent = [];
    await app.register(jobsRoutes, {
      proxy: { send: async (command: string, payload?: unknown) => { sent.push({ command, payload }); return {}; } },
      idleTimer: { reset: () => undefined },
    });
    await app.ready();
  });
  afterEach(async () => { await app.close(); });

  it('acknowledges one job when given its id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/failures/ack', payload: { jobId: 'post-process-10h' } });
    expect(res.statusCode).toBe(204);
    expect(sent).toEqual([{ command: 'ack-failures', payload: { jobId: 'post-process-10h' } }]);
  });

  it('acknowledges everything when given no id, as "Acknowledge all" does', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/failures/ack', payload: {} });
    expect(res.statusCode).toBe(204);
    expect(sent).toEqual([{ command: 'ack-failures', payload: undefined }]);
  });

  it('acknowledges everything when there is no body at all', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/failures/ack' });
    expect(res.statusCode).toBe(204);
    expect(sent[0]?.command).toBe('ack-failures');
    expect(sent[0]?.payload).toBeUndefined();
  });

  it('answers 400, and acknowledges nothing, for an id that is not a string', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/failures/ack', payload: { jobId: 42 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/jobId/);
    expect(sent).toEqual([]);
  });
});
