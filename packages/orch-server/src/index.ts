import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import { isAllowedOrigin } from './cors.js';
import { DaemonProxy } from './daemon-proxy.js';
import { IdleTimer } from './idle-timer.js';
import { findFreePort, writeDashboardPort, deleteDashboardPort } from './port.js';
import { jobsRoutes } from './routes/jobs.js';
import { logsRoutes } from './routes/logs.js';
import { heartbeatRoute } from './routes/heartbeat.js';
import { openRoute } from './routes/open.js';
// eventsRoute is co-located in heartbeat.ts (workaround for Fastify v5 + @fastify/static route loss)

// Parse CLI args
function parseArgs(): { configDir: string; basePort: number; appDir: string | null } {
  const args = process.argv.slice(2);
  let configDir = '';
  let basePort = 47950;
  let appDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config-dir' && args[i + 1]) {
      configDir = args[++i];
    }
    if (args[i] === '--base-port' && args[i + 1]) {
      basePort = parseInt(args[++i], 10);
    }
    if (args[i] === '--app-dir' && args[i + 1]) {
      appDir = args[++i];
    }
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

// CORS -- allow same-origin and loopback requests (localhost, 127.0.0.1, [::1])
await server.register(fastifyCors, {
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) {
      cb(null, true);
    } else {
      // Name the rejected origin: the browser only reports an opaque 500, and
      // index.html loads its bundle with `crossorigin`, so a rejected origin
      // shows up as a blank page with no clue in the console.
      cb(new Error(`Origin not allowed by CORS: ${origin} (dashboard accepts loopback origins only)`), false);
    }
  },
});

await server.register(jobsRoutes, { proxy, idleTimer });
await server.register(logsRoutes, { configDir, idleTimer });
await server.register(heartbeatRoute, { idleTimer, proxy });

// Open a local file with the OS default handler (the log viewer's file links). See routes/open.ts for
// what it will and will not open.
await server.register(openRoute, { idleTimer });

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
