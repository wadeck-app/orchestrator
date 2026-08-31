import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { IdleTimer } from '../idle-timer.js';

const JOB_ID_RE = /^[a-z0-9-]+$/i;

export async function logsRoutes(
  fastify: FastifyInstance,
  opts: { configDir: string; idleTimer: IdleTimer }
): Promise<void> {
  const { configDir, idleTimer } = opts;

  fastify.get('/api/logs/:jobId/stream', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!JOB_ID_RE.test(jobId)) {
      return reply.code(400).send({ error: 'invalid-job-id' });
    }

    const logPath = path.join(configDir, 'logs', `${jobId}.log`);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    idleTimer.addSseConnection();

    const send = (line: string): void => {
      reply.raw.write(`data: ${line}\n\n`);
    };

    // Send historical lines
    if (fs.existsSync(logPath)) {
      const rl = readline.createInterface({
        input: fs.createReadStream(logPath),
        crlfDelay: Infinity,
      });
      for await (const line of rl) send(line);
    }

    // Watch for new lines
    let watcher: fs.FSWatcher | null = null;
    let fileSize = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

    const watchDir = path.dirname(logPath);
    // fs.watch requires the directory to exist
    if (fs.existsSync(watchDir)) {
      watcher = fs.watch(watchDir, { persistent: false }, (_event, filename) => {
        if (filename !== `${jobId}.log`) return;
        try {
          const newSize = fs.statSync(logPath).size;
          if (newSize <= fileSize) return;
          const stream = fs.createReadStream(logPath, { start: fileSize });
          fileSize = newSize;
          const rl2 = readline.createInterface({ input: stream, crlfDelay: Infinity });
          rl2.on('line', send);
        } catch {
          // file may have been rotated
        }
      });
    }

    req.raw.on('close', () => {
      watcher?.close();
      idleTimer.removeSseConnection();
    });
  });
}
