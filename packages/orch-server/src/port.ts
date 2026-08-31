import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export async function findFreePort(base: number): Promise<number> {
  for (let port = base; port <= base + 10; port++) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port found in range ${base}-${base + 10}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export interface DashboardPortInfo {
  port: number;
  pid: number;
  startedAt: string;
}

export function writeDashboardPort(configDir: string, port: number, pid: number): void {
  const info: DashboardPortInfo = { port, pid, startedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(configDir, 'config.dashboard'), JSON.stringify(info, null, 2), 'utf8');
}

export function deleteDashboardPort(configDir: string): void {
  try {
    fs.unlinkSync(path.join(configDir, 'config.dashboard'));
  } catch {
    // ignore -- file may already be gone
  }
}
