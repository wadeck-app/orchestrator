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
      const [jobs, state, uptime] = await Promise.all([
        proxy.send('list-jobs') as Promise<{ id: string }[]>,
        proxy.send('list-state') as Promise<Record<string, unknown>>,
        proxy.send('get-uptime').catch(() => ({})) as Promise<Record<string, number | null>>,
      ]);
      const result = jobs.map((job) => ({
        job,
        runHistory: (state[job.id] as unknown[] | undefined) ?? [],
        uptimePercent: (uptime as Record<string, number | null>)[job.id] ?? null,
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
      return reply.send({ job, runHistory: (state[id] as unknown[] | undefined) ?? [] });
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
      const ip        = req.ip;
      const userAgent = req.headers['user-agent'];
      await proxy.send('trigger-job', { id, ip, userAgent });
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

  fastify.get('/api/failures', async (_req, reply) => {
    return guard(reply, async () => {
      const failures = await proxy.send('list-failures');
      return reply.send(failures);
    });
  });

  fastify.post('/api/failures/ack', async (_req, reply) => {
    return guard(reply, async () => {
      await proxy.send('ack-failures');
      return reply.code(204).send();
    });
  });

  fastify.get('/api/jobs/export', async (_req, reply) => {
    return guard(reply, async () => {
      const jobs = await proxy.send('list-jobs') as unknown[];
      const payload = JSON.stringify({ version: 1, jobs }, null, 2);
      return reply
        .header('Content-Type', 'application/json')
        .header('Content-Disposition', `attachment; filename="orchestrator-jobs-${new Date().toISOString().slice(0, 10)}.json"`)
        .send(payload);
    });
  });

  fastify.post('/api/jobs/import', async (req, reply) => {
    return guard(reply, async () => {
      const body = req.body as { jobs?: unknown[] };
      if (!body?.jobs || !Array.isArray(body.jobs)) {
        return reply.code(400).send({ error: 'invalid-payload: expected { jobs: [] }' });
      }
      const results: Array<{ id: string; status: string }> = [];
      for (const job of body.jobs) {
        try {
          await proxy.send('add-job', job);
          results.push({ id: (job as { id?: string }).id ?? '?', status: 'imported' });
        } catch (e) {
          results.push({ id: (job as { id?: string }).id ?? '?', status: 'error' });
        }
      }
      return reply.send({ imported: results.filter(r => r.status === 'imported').length, results });
    });
  });

  fastify.get('/api/schedule', async (_req, reply) => {
    return guard(reply, async () => {
      const schedule = await proxy.send('get-schedule');
      return reply.send(schedule);
    });
  });

  fastify.get('/api/audit', async (req, reply) => {
    return guard(reply, async () => {
      const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
      const entries = await proxy.send('list-audit', { limit });
      return reply.send(entries);
    });
  });

  fastify.get('/api/uptime', async (_req, reply) => {
    return guard(reply, async () => {
      const uptime = await proxy.send('get-uptime');
      return reply.send(uptime);
    });
  });

  fastify.get('/api/jobs/:jobId/resource-baseline', async (req, reply) => {
    return guard(reply, async () => {
      const { jobId } = req.params as { jobId: string };
      const baseline = await proxy.send('get-resource-baseline', { jobId }) as { cpuPct: number; ramMb: number } | null;
      return reply.send(baseline ?? null);
    });
  });

  fastify.get('/api/webhooks', async (_req, reply) => {
    return guard(reply, async () => reply.send(await proxy.send('list-webhooks')));
  });

  fastify.post('/api/webhooks', async (req, reply) => {
    return guard(reply, async () => {
      await proxy.send('add-webhook', req.body);
      return reply.code(201).send({ ok: true });
    });
  });

  fastify.delete('/api/webhooks/:id', async (req, reply) => {
    return guard(reply, async () => {
      await proxy.send('remove-webhook', { id: (req.params as { id: string }).id });
      return reply.code(204).send();
    });
  });

  fastify.patch('/api/webhooks/:id/toggle', async (req, reply) => {
    return guard(reply, async () => {
      const result = await proxy.send('toggle-webhook', { id: (req.params as { id: string }).id });
      return reply.send(result);
    });
  });

  fastify.post('/api/jobs/:id/dry-run', async (req, reply) => {
    return guard(reply, async () => {
      const result = await proxy.send('dry-run-job', { id: (req.params as { id: string }).id });
      return reply.send(result);
    });
  });

  fastify.get('/api/secrets', async (_req, reply) => {
    return guard(reply, async () => reply.send(await proxy.send('list-secrets')));
  });

  fastify.post('/api/secrets', async (req, reply) => {
    return guard(reply, async () => {
      await proxy.send('set-secret', req.body);
      return reply.code(201).send({ ok: true });
    });
  });

  fastify.delete('/api/secrets/:name', async (req, reply) => {
    return guard(reply, async () => {
      await proxy.send('delete-secret', { name: (req.params as { name: string }).name });
      return reply.code(204).send();
    });
  });

}
