import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { DaemonProxy } from './daemon-proxy.js';
import { IdleTimer } from './idle-timer.js';
import { findFreePort, writeDashboardPort, deleteDashboardPort } from './port.js';
import { jobsRoutes } from './routes/jobs.js';
import { logsRoutes } from './routes/logs.js';
import { heartbeatRoute } from './routes/heartbeat.js';
// eventsRoute is co-located in heartbeat.ts (workaround for Fastify v5 + @fastify/static route loss)

// Parse CLI args
function parseArgs(): { configDir: string; basePort: number; appDir: string | null } {
  const args = process.argv.slice(2);
  let configDir = '';
  let basePort = 47950;
  let appDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-dir' && args[i + 1]) configDir = args[++i];
    if (args[i] === '--base-port' && args[i + 1]) basePort = parseInt(args[++i], 10);
    if (args[i] === '--app-dir' && args[i + 1]) appDir = args[++i];
  }
  if (!configDir) {
    process.stderr.write('Error: --config-dir is required\n');
    process.exit(1);
  }
  return { configDir, basePort, appDir };
}

const { configDir, basePort, appDir: appDirArg } = parseArgs();
const timeoutMs = Number(process.env.ORCH_DASHBOARD_IDLE_TIMEOUT_MS ?? '600000');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = appDirArg ?? path.resolve(__dirname, '../public');
const hasPublic = fs.existsSync(publicDir);

const proxy = new DaemonProxy(configDir);

function onIdle(): void {
  process.stdout.write(JSON.stringify({ type: 'idle-exit' }) + '\n');
  deleteDashboardPort(configDir);
  void server.close();
  process.exit(0);
}

const idleTimer = new IdleTimer(timeoutMs, onIdle);

const server = Fastify({ logger: false });

// CORS -- allow same-origin localhost requests
await server.register(fastifyCors, {
  origin: (origin, cb) => {
    if (!origin || origin.startsWith('http://localhost')) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'), false);
    }
  },
});

await server.register(jobsRoutes, { proxy, idleTimer });
await server.register(logsRoutes, { configDir, idleTimer });
await server.register(heartbeatRoute, { idleTimer, proxy });

// Open a local file or URL using the OS default handler.
// Chrome blocks file:// navigation from http:// pages — this proxies the open via server.
server.get('/api/open', async (req, reply) => {
  const { path: rawPath } = req.query as { path?: string };
  if (!rawPath) return reply.code(400).send({ error: 'path required' });
  idleTimer.reset();
  const target = decodeURIComponent(rawPath);
  // Security: only allow file:// URLs and http(s)://localhost — never remote URLs
  const isFileUrl   = target.startsWith('file:///');
  const isLocalHttp = target.startsWith('http://localhost') || target.startsWith('https://localhost');
  const isWinPath   = /^[A-Za-z]:[\\\/]/.test(target);
  if (!isFileUrl && !isLocalHttp && !isWinPath) {
    return reply.code(403).send({ error: 'only local file paths and localhost URLs are allowed' });
  }
  const url = isWinPath ? `file:///${target.replace(/\\/g, '/')}` : target;
  await new Promise<void>((resolve) => {
    if (process.platform === 'win32') {
      execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: false }, () => resolve());
    } else {
      execFile('open', [url], () => resolve());
    }
  });
  return reply.code(204).send();
});

// Static file serving (orch-app dist)
if (hasPublic) {
  await server.register(fastifyStatic, {
    root: publicDir,
  });
}

// events SSE registered via register() - required in Fastify v5 after init phase

// SPA fallback
server.setNotFoundHandler((_req, reply) => {
  if (_req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'not-found' });
  }
  if (hasPublic) {
    return reply.sendFile('index.html');
  }
  return reply.code(404).send({ error: 'dashboard-not-built' });
});

// Start
const port = await findFreePort(basePort);
await server.listen({ port, host: '127.0.0.1' });
writeDashboardPort(configDir, port, process.pid);
process.stdout.write(JSON.stringify({ type: 'ready', port }) + '\n');
idleTimer.reset();

// Graceful shutdown
function shutdown(): void {
  idleTimer.stop();
  deleteDashboardPort(configDir);
  void server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
