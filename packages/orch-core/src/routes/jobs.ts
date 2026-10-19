import type { IdleSignal, RouteHost, RouteReply } from '../route-host.js';
import { DaemonProxy, DaemonUnavailableError } from '../daemon-proxy.js';

interface HealthRunEntry {
  startedAt: string;
  exitCode: number | null;
  finishedAt?: string;
  skipped?: boolean;
  cancelledByUser?: boolean;
}

// Same rule as isFailure in orchestrator-cli/src/state.ts (orch-core must not import the daemon): a
// skipped run keeps the child's real exit code and is not a failure, and a null code is a run killed or
// orphaned, not a fault of the job. A run the user ended is not a failure either.
function isFailedRun(entry: HealthRunEntry | null): boolean {
  return entry !== null && !entry.skipped && !entry.cancelledByUser && entry.exitCode != null && entry.exitCode !== 0;
}

// Run history is not guaranteed to be ordered newest-first, so resolve by startedAt.
function newestRun(entries: HealthRunEntry[] | undefined): HealthRunEntry | null {
  if (!entries || entries.length === 0) {
    return null;
  }
  return entries.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
}

/**
 * Only what these handlers actually touch: one method from each collaborator.
 *
 * Structural rather than the concrete classes, because `DaemonProxy` carries private state that a
 * plain object cannot satisfy -- so every test had to write `{ send } as any`, and that cast was
 * hiding how narrow the real coupling is. A real DaemonProxy and IdleTimer still satisfy this, so
 * nothing at the call sites changes.
 */
export interface JobsRouteDeps {
  proxy: Pick<DaemonProxy, 'send'>;
  idleTimer: Pick<IdleSignal, 'reset'>;
}

export async function jobsRoutes(
  fastify: RouteHost,
  opts: JobsRouteDeps
): Promise<void> {
  const { proxy, idleTimer } = opts;

  async function guard<T>(reply: RouteReply, fn: () => Promise<T>): Promise<T | RouteReply | void> {
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
      // `updates`, not spread: edit-job reads payload.updates. Flattening left it undefined, the
      // daemon threw on Object.keys(undefined), and Save in the web UI did nothing at all.
      //
      // `unset` travels beside `updates`, not inside it: an edit is a patch, so an omitted field
      // means "leave it alone" and a client clearing e.g. the working directory has to name it.
      // Left inside, the daemon would take "unset" for a job field.
      const { unset, ...fields } = (req.body ?? {}) as { unset?: string[] } & Record<string, unknown>;
      const result = await proxy.send('edit-job', {
        id, updates: fields, ...(unset !== undefined ? { unset } : {}),
      });
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

  // A job at its concurrency limit refuses a trigger. That is an outcome the caller needs to hear
  // about, not an error, so it travels as a 200 with the daemon's status; a trigger that started
  // keeps answering 204.
  const isRefused = (result: unknown): result is { status: 'already-running' } =>
    typeof result === 'object' && result !== null
    && (result as { status?: unknown }).status === 'already-running';

  fastify.post('/api/jobs/:id/trigger', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      const { force } = req.query as { force?: string };
      const ip        = req.ip;
      const userAgent = req.headers['user-agent'];
      const result = await proxy.send('trigger-job', { id, ip, userAgent, force: force === 'true' });
      if (isRefused(result)) {
        return reply.code(200).send(result);
      }
      return reply.code(204).send();
    });
  });

  fastify.post('/api/jobs/:id/trigger-early', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      const { force } = req.query as { force?: string };
      const ip        = req.ip;
      const userAgent = req.headers['user-agent'];
      const result = await proxy.send('trigger-job', { id, ip, userAgent, force: force === 'true' });
      // Skipping the next firing is what running early means once it ran; nothing ran here.
      if (isRefused(result)) {
        return reply.code(200).send(result);
      }
      await proxy.send('skip-next-firing', { id });
      return reply.code(204).send();
    });
  });

  fastify.post('/api/jobs/:id/kill', async (req, reply) => {
    return guard(reply, async () => {
      const { id } = req.params as { id: string };
      const ip        = req.ip;
      const userAgent = req.headers['user-agent'];
      const result = await proxy.send('kill-job', { id, ip, userAgent });
      if (!(result as { killed: boolean }).killed) {
        return reply.code(404).send({ error: `Job "${id}" is not currently running` });
      }
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

  /*
   * { jobId } acknowledges that job's failure, no body (or an empty one) all of them. The route used to
   * ignore its body, so the per-job button of the failure notifications acknowledged every failure on
   * the server while hiding a single card.
   */
  fastify.post('/api/failures/ack', async (req, reply) => {
    const body = req.body as { jobId?: unknown } | null | undefined;
    const jobId = body?.jobId;
    if (jobId !== undefined && typeof jobId !== 'string') {
      return reply.code(400).send({ error: 'jobId must be a string when given (omit it to acknowledge every failure)' });
    }
    return guard(reply, async () => {
      await proxy.send('ack-failures', jobId === undefined ? undefined : { jobId });
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

  // One run's resource curve. `run` is a run's startedAt; without it the daemon answers the newest run.
  // A malformed run is refused here, with the way to fix it, instead of reaching the daemon as a guess.
  fastify.get('/api/jobs/:jobId/telemetry', async (req, reply) => {
    const { run } = req.query as { run?: unknown };
    if (run !== undefined && (typeof run !== 'string' || run === '')) {
      return reply.code(400).send({ error: 'run must be a single run startedAt (an ISO timestamp from the run history), or omitted for the newest run' });
    }
    return guard(reply, async () => {
      const { jobId } = req.params as { jobId: string };
      const telemetry = await proxy.send('get-run-telemetry', run === undefined ? { jobId } : { jobId, run });
      return reply.send(telemetry);
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

  // One-shot exec API -- run a command without creating a permanent job
  fastify.post('/api/exec', async (req, reply) => {
    return guard(reply, async () => {
      const { command, cwd, timeout, env, label } = req.body as {
        command?: string; cwd?: string; timeout?: number; env?: Record<string, string>; label?: string;
      };
      if (!command?.trim()) {
        return reply.code(400).send({ error: 'command is required' });
      }
      const result = await proxy.send('exec-run', { command, cwd, timeout, env, label });
      return reply.code(202).send(result);
    });
  });

  fastify.get('/api/exec', async (_req, reply) => {
    return guard(reply, async () => reply.send(await proxy.send('exec-list')));
  });

  fastify.get('/api/exec/:runId', async (req, reply) => {
    return guard(reply, async () => {
      const result = await proxy.send('exec-status', { runId: (req.params as { runId: string }).runId });
      if ((result as { error?: string }).error === 'not-found') {
        return reply.code(404).send(result);
      }
      return reply.send(result);
    });
  });

  fastify.delete('/api/exec/:runId', async (req, reply) => {
    return guard(reply, async () => {
      const result = await proxy.send('exec-kill', { runId: (req.params as { runId: string }).runId });
      return reply.send(result);
    });
  });

  fastify.get('/api/health', async (_req, reply) => {
    return guard(reply, async () => {
      const [jobs, stateData] = await Promise.all([
        proxy.send('list-jobs') as Promise<{ id: string }[]>,
        proxy.send('list-state') as Promise<Record<string, HealthRunEntry[]>>,
      ]);
      const latest = Object.values(stateData).map(newestRun);
      // Liveness is finishedAt: a run killed by signal has no exit code, so testing
      // exitCode would report it as still running forever. Jobs with ANY open run, not the newest
      // one: with several instances alive the newest may have ended while an older one still runs.
      const runningCount = Object.values(stateData).filter(entries => entries.some(e => e.finishedAt == null)).length;
      const failureCount = latest.filter(isFailedRun).length;
      return reply.send({
        status: failureCount > 0 ? 'degraded' : runningCount > 0 ? 'busy' : 'ok',
        totalJobs: jobs.length,
        runningJobs: runningCount,
        recentFailures: failureCount,
        // The dashboard server's own process uptime, not the daemon's.
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    });
  });

}
