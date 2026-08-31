import type { FastifyInstance } from 'fastify';
import { IdleTimer } from '../idle-timer.js';

export async function heartbeatRoute(
  fastify: FastifyInstance,
  opts: { idleTimer: IdleTimer }
): Promise<void> {
  fastify.post('/api/heartbeat', async (_req, reply) => {
    opts.idleTimer.reset();
    return reply.code(204).send();
  });
}
