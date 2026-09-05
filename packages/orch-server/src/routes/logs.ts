import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { IdleTimer } from '../idle-timer.js';

const JOB_ID_RE = /^[a-z0-9-]+$/i;
const POLL_INTERVAL_MS = 500;

/**
 * Returns the path to the most recent <jobId>-YYYY-MM-DD.log file in logDir,
 * or null if none exists.
 */
export function findLatestLogFile(logDir: string, jobId: string): string | null {
  if (!fs.existsSync(logDir)) return null;
  const pattern = new RegExp(`^${escapeRegExp(jobId)}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
  let entries: string[];
  try {
    entries = fs.readdirSync(logDir);
  } catch {
    return null;
  }
  const matches = entries.filter(f => pattern.test(f)).sort();
  if (matches.length === 0) return null;
  return path.join(logDir, matches[matches.length - 1]!);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

    const logDir = path.join(configDir, 'logs', jobId);

    reply.hijack();
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

    // Send historical lines from the latest existing log file
    let currentLogPath = findLatestLogFile(logDir, jobId);
    let fileSize = 0;

    if (currentLogPath !== null) {
      try {
        const rl = readline.createInterface({
          input: fs.createReadStream(currentLogPath),
          crlfDelay: Infinity,
        });
        for await (const line of rl) send(line);
        fileSize = fs.statSync(currentLogPath).size;
      } catch {
        // log file may not be readable yet
      }
    }

    // Poll for new lines every POLL_INTERVAL_MS (reliable on Windows, avoids fs.watch quirks)
    const pollTimer = setInterval(() => {
      try {
        const latestPath = findLatestLogFile(logDir, jobId);
        if (latestPath === null) return;

        // Date rolled over - new log file appeared
        if (latestPath !== currentLogPath) {
          currentLogPath = latestPath;
          fileSize = 0;
        }

        const newSize = fs.statSync(currentLogPath!).size;
        if (newSize <= fileSize) return;

        const stream = fs.createReadStream(currentLogPath!, { start: fileSize });
        fileSize = newSize;
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', send);
      } catch {
        // transient error - file may be rotating
      }
    }, POLL_INTERVAL_MS);

    req.raw.on('close', () => {
      clearInterval(pollTimer);
      idleTimer.removeSseConnection();
    });
  });
}
