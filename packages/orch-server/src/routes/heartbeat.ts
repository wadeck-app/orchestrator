import type { FastifyInstance } from 'fastify';
import { IdleTimer } from '../idle-timer.js';
import type { DaemonProxy } from '../daemon-proxy.js';
import { DaemonUnavailableError } from '../daemon-proxy.js';

const EVENTS_POLL_MS = parseInt(process.env['ORCH_EVENTS_POLL_MS'] ?? '5000', 10);

export async function heartbeatRoute(
  fastify: FastifyInstance,
  opts: { idleTimer: IdleTimer; proxy: DaemonProxy }
): Promise<void> {
  const { idleTimer, proxy } = opts;

  fastify.post('/api/heartbeat', async (_req, reply) => {
    idleTimer.reset();
    return reply.code(204).send();
  });

  // SSE events endpoint co-located here because registering it as a
  // separate plugin causes route loss (Fastify v5 + @fastify/static interaction).
  fastify.get('/api/events', async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    idleTimer.addSseConnection();
    reply.raw.write('event: connected\ndata: {}\n\n');

    const pollTimer = setInterval(async () => {
      try {
        const state = await proxy.send('list-state');
        reply.raw.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
      } catch (err) {
        if (err instanceof DaemonUnavailableError) {
          reply.raw.write('event: daemon-unavailable\ndata: {}\n\n');
        }
      }
    }, EVENTS_POLL_MS);

    req.raw.on('close', () => {
      clearInterval(pollTimer);
      idleTimer.removeSseConnection();
    });
  });
}
