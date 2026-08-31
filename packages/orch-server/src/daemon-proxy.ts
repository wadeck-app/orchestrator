import * as fs from 'node:fs';
import * as path from 'node:path';

export class DaemonUnavailableError extends Error {
  constructor() {
    super('daemon-not-running');
    this.name = 'DaemonUnavailableError';
  }
}

interface PortInfo {
  port: number;
  pid: number;
  startedAt: string;
}

function readDaemonPort(configDir: string): number {
  const filePath = path.join(configDir, 'config.port');
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new DaemonUnavailableError();
  }
  const stat = fs.statSync(filePath);
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > 60_000) throw new DaemonUnavailableError();
  const info = JSON.parse(raw) as PortInfo;
  return info.port;
}

export class DaemonProxy {
  private readonly _configDir: string;

  constructor(configDir: string) {
    this._configDir = configDir;
  }

  async send(command: string, payload?: unknown): Promise<unknown> {
    const port = readDaemonPort(this._configDir);
    const url = `http://127.0.0.1:${port}/${command}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Daemon RPC error ${res.status}: ${text}`);
    }
    return res.json();
  }
}
