import type { FastifyInstance, FastifyReply } from 'fastify';
import { DaemonProxy, DaemonUnavailableError } from '../daemon-proxy.js';
import { IdleTimer } from '../idle-timer.js';

export async function jobsRoutes(
  fastify: FastifyInstance,
  opts: { proxy: DaemonProxy; idleTimer: IdleTimer }
): Promise<void> {
  const { proxy, idleTimer } = opts;

  async function guard<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T | void> {
    try {
      idleTimer.reset();
      return await fn();
    } catch (err) {
      if (err instanceof DaemonUnavailableError) {
        return reply.code(503).send({ error: 'daemon-not-running' });
      }
      throw err;
    }
  }

  fastify.get('/api/jobs', async (_req, reply) => {
    return guard(reply, async () => {
      const [jobs, state] = await Promise.all([
        proxy.send('list-jobs') as Promise<{ id: string }[]>,
        proxy.send('list-state') as Promise<Record<string, unknown>>,
      ]);
      const result = jobs.map((job) => ({
        job,
        lastRun: state[job.id] ?? null,
      }));
      return reply.send(result);
    });
  });

  fastify.get('/api/jobs/:id', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      const [job, state] = await Promise.all([
        proxy.send('get-job', { id }),
        proxy.send('list-state') as Promise<Record<string, unknown>>,
      ]);
      return reply.send({ job, lastRun: state[id] ?? null });
    });
  });

  fastify.post('/api/jobs', async (req, reply) => {
    return guard(reply, async () => {
      const result = await proxy.send('add-job', req.body);
      return reply.code(201).send(result);
    });
  });

  fastify.put('/api/jobs/:id', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      const result = await proxy.send('edit-job', { id, ...(req.body as object) });
      return reply.send(result);
    });
  });

  fastify.delete('/api/jobs/:id', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      await proxy.send('remove-job', { id });
      return reply.code(204).send();
    });
  });

  fastify.post('/api/jobs/:id/trigger', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      await proxy.send('trigger-job', { id });
      return reply.code(204).send();
    });
  });

  fastify.post('/api/jobs/:id/enable', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      await proxy.send('enable-job', { id });
      return reply.code(204).send();
    });
  });

  fastify.post('/api/jobs/:id/disable', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      await proxy.send('disable-job', { id });
      return reply.code(204).send();
    });
  });
}
