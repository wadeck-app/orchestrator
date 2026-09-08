import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { IdleTimer } from '../idle-timer.js';

const JOB_ID_RE = /^[a-z0-9-]+$/i;
const POLL_INTERVAL_MS = 500;

/**
 * Returns all log files for a job, sorted oldest→newest.
 * Supports both formats:
 *   - per-run:  <jobId>-YYYY-MM-DDTHH-MM-SS.log  (new)
 *   - daily:    <jobId>-YYYY-MM-DD.log             (legacy)
 */
export function listLogFiles(logDir: string, jobId: string): string[] {
  if (!fs.existsSync(logDir)) return [];
  const esc = escapeRegExp(jobId);
  const runPat   = new RegExp(`^${esc}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.log$`);
  const dailyPat = new RegExp(`^${esc}-\\d{4}-\\d{2}-\\d{2}\\.log$`);
  let entries: string[];
  try { entries = fs.readdirSync(logDir); } catch { return []; }
  return entries
    .filter(f => runPat.test(f) || dailyPat.test(f))
    .sort()
    .map(f => path.join(logDir, f));
}

/**
 * Returns the path to the most recent log file for a job, or null if none exists.
 */
export function findLatestLogFile(logDir: string, jobId: string): string | null {
  const files = listLogFiles(logDir, jobId);
  return files.length > 0 ? files[files.length - 1]! : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function logsRoutes(
  fastify: FastifyInstance,
  opts: { configDir: string; idleTimer: IdleTimer }
): Promise<void> {
  const { configDir, idleTimer } = opts;

  // List available run log files for a job
  fastify.get('/api/logs/:jobId/runs', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!JOB_ID_RE.test(jobId)) return reply.code(400).send({ error: 'invalid-job-id' });
    idleTimer.reset();
    const logDir = path.join(configDir, 'logs', jobId);
    const files  = listLogFiles(logDir, jobId);
    const runs = files.map(f => {
      const name = path.basename(f, '.log').slice(jobId.length + 1); // strip "<jobId>-"
      return { name, file: path.basename(f), sizeBytes: (() => { try { return fs.statSync(f).size; } catch { return 0; } })() };
    }).reverse(); // most recent first
    return reply.send(runs);
  });

  fastify.get('/api/logs/:jobId/stream', async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    if (!JOB_ID_RE.test(jobId)) {
      return reply.code(400).send({ error: 'invalid-job-id' });
    }

    // Optional ?run=<name> to stream a specific run log
    const runName = (req.query as { run?: string }).run;

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

    // Send historical lines from the requested run log, or the latest
    let currentLogPath = runName
      ? (() => { const p = path.join(logDir, `${jobId}-${runName}.log`); return fs.existsSync(p) ? p : null; })()
      : findLatestLogFile(logDir, jobId);
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
