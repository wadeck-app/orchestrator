import type { FastifyInstance } from 'fastify';
import { DaemonProxy, DaemonUnavailableError } from '../daemon-proxy.js';
import { IdleTimer } from '../idle-timer.js';

const POLL_INTERVAL_MS = parseInt(process.env['ORCH_EVENTS_POLL_MS'] ?? '5000', 10);

export async function eventsRoute(
  fastify: FastifyInstance,
  opts: { proxy: DaemonProxy; idleTimer: IdleTimer; pollIntervalMs?: number }
): Promise<void> {
  const { proxy, idleTimer, pollIntervalMs = POLL_INTERVAL_MS } = opts;

  fastify.get('/api/events', async (req, reply) => {
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
    }, pollIntervalMs);

    req.raw.on('close', () => {
      clearInterval(pollTimer);
      idleTimer.removeSseConnection();
    });
  });
}
