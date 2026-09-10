import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { getErrorMessage } from './fsUtil.js';

const KILL_TIMEOUT_MS = 3000;

interface DashboardPortInfo {
  port: number;
  pid: number;
  startedAt: string;
}

export class DashboardManager {
  private _proc: ChildProcess | null = null;
  private _running = false;
  private _port: number | null = null;
  private readonly _log: (msg: string) => void;

  constructor(
    private readonly _configDir: string,
    private readonly _serverBinaryPath: string,
    onLog?: (msg: string) => void,
  ) {
    this._log = onLog ?? ((msg) => { try { process.stderr.write(`[dashboard] ${msg}\n`); } catch { /* ignore */ } });
  }

  private _killStaleFromFile(): void {
    try {
      const filePath = path.join(this._configDir, 'config.dashboard');
      const raw = fs.readFileSync(filePath, 'utf8');
      const info = JSON.parse(raw) as DashboardPortInfo;
      if (!info.pid) return;
      // Check if the process is still alive
      try { process.kill(info.pid, 0); } catch { return; /* already dead */ }
      // Kill the orphaned dashboard process tree
      if (process.platform === 'win32') {
        try { execSync(`taskkill /f /t /pid ${info.pid}`, { stdio: 'ignore' }); } catch { /* ignore */ }
      } else {
        try { process.kill(info.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      // Remove stale file so the new server can write fresh port
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    } catch { /* file absent or invalid — nothing to kill */ }
  }

  start(): Promise<void> {
    if (this._running) return Promise.resolve();
    this._killStaleFromFile();

    return new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [
        this._serverBinaryPath,
        '--config-dir', this._configDir,
        '--base-port', '47950',
      ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      this._proc = child;
      let settled = false;

      const rl = createInterface({ input: child.stdout! });
      rl.on('line', (line) => {
        let msg: { type: string; port?: number };
        try { msg = JSON.parse(line) as typeof msg; } catch { return; }

        if (msg.type === 'ready') {
          this._running = true;
          this._port = msg.port ?? null;
          if (!settled) { settled = true; resolve(); }
        } else if (msg.type === 'idle-exit') {
          this._running = false;
          this._port = null;
          this._proc = null;
        }
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        // Route dashboard server stderr to the daemon log (not process.stderr which is
        // invisible when the daemon runs as a hidden Windows process)
        this._log(`[dashboard-server] ${chunk.toString().trimEnd()}`);
      });

      child.on('error', (err) => {
        this._running = false;
        this._port = null;
        this._proc = null;
        if (!settled) { settled = true; reject(err); }
      });

      child.on('close', (code) => {
        this._running = false;
        this._port = null;
        this._proc = null;
        if (!settled) {
          settled = true;
          reject(new Error(`dashboard server exited before ready (code=${code})`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this._proc;
    if (!child) return;

    this._running = false;
    this._port = null;
    this._proc = null;

    child.kill('SIGTERM');

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };

      child.once('close', finish);

      setTimeout(() => {
        if (!done) {
          try { child.kill('SIGKILL'); } catch { /* already dead */ }
          finish();
        }
      }, KILL_TIMEOUT_MS);
    });
  }

  isRunning(): boolean {
    return this._running;
  }

  getPort(): number | null {
    // Fast path: use in-memory port
    if (this._port !== null) return this._port;

    // Fallback: read from config.dashboard file
    try {
      const filePath = path.join(this._configDir, 'config.dashboard');
      const raw = fs.readFileSync(filePath, 'utf8');
      const stat = fs.statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > 60_000) return null;
      const info = JSON.parse(raw) as DashboardPortInfo;
      return info.port;
    } catch {
      return null;
    }
  }

  openBrowser(): void {
    const port = this.getPort();
    if (port === null) {
      this._log('[dashboard] cannot open browser: port unknown (config.dashboard missing or stale)');
      return;
    }
    const url = `http://localhost:${port}`;
    this._log(`[dashboard] opening browser: ${url}`);
    if (process.platform === 'win32') {
      // Use cmd /c start which handles http:// URLs reliably on all Windows versions.
      // explorer.exe with a URL can fail on some Windows 11 configurations when the
      // default browser association is not set up for explorer.exe to delegate.
      // violations-suppress: cli/daemon-spawn-no-windows-hide intentionally opens the browser as a visible window
      execFile('cmd.exe', ['/c', 'start', '', url], (err) => {
        if (err) this._log(`[dashboard] open browser failed (cmd /c start "${url}"): ${getErrorMessage(err)}`);
        else this._log(`[dashboard] browser opened successfully`);
      });
    } else {
      // violations-suppress: cli/daemon-spawn-no-windows-hide intentionally opens the browser as a visible window
      execFile('open', [url], (err) => {
        if (err) this._log(`[dashboard] open browser failed (open "${url}"): ${getErrorMessage(err)}`);
        else this._log(`[dashboard] browser opened successfully`);
      });
    }
  }
}
