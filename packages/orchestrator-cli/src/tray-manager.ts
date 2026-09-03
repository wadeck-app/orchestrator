import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { DailyLogger } from './logger.js';
import { TrayProcess, type MenuSnapshot, type MenuItemSnapshot } from './tray-process.js';
import { getIcons } from './tray-icons.js';
import { enableStartup, disableStartup, isStartupEnabled } from './startup.js';
import type { State } from './state.js';
import type { Registry } from './registry.js';
import { getErrorMessage } from './fsUtil.js';
import type { Scheduler } from './scheduler.js';
import type { Job } from './types.js';
import type { DashboardManager } from './dashboard-manager.js';

const MAX_FAILURES = 5;

const TRAY_BINARY =
  process.platform === 'win32'
    ? 'orchestrator-tray.exe'
    : process.arch === 'arm64'
      ? 'orchestrator-tray-arm64'
      : 'orchestrator-tray-amd64';

// Binary name as stored inside the platform package (arch is encoded in the package name itself).
const PLATFORM_TRAY_BINARY = process.platform === 'win32' ? 'orchestrator-tray.exe' : 'orchestrator-tray';

const _PLATFORM_PKG: Record<string, string> = {
  'win32-x64':    '@wadeck-app/orchestrator-cli-win32-x64',
  'darwin-arm64': '@wadeck-app/orchestrator-cli-darwin-arm64',
  'darwin-x64':   '@wadeck-app/orchestrator-cli-darwin-x64',
};
const _platformArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const _platformKey  = `${process.platform}-${_platformArch}`;
const _platformPkg  = _PLATFORM_PKG[_platformKey];

interface FailureEntry {
  id:       string;
  label:    string;
  exitCode: number;
  message:  string | null;
  time:     string;
}

const SUCCESS_FLASH_MS = 5_000;
const SUCCESS_ICON_COLOR = '#6EE7B7';

export class TrayManager extends EventEmitter {
  private _tp:               TrayProcess | null = null;
  private _intentionalStop   = false;  // true during kill-before-restart/quit; suppresses onExit restart
  private _restartAttempt    = 0;
  private _restartTimer:     ReturnType<typeof setTimeout> | null = null;
  private _successTimer:   ReturnType<typeof setTimeout> | null = null;
  private _showSuccess     = false;
  private _startupEnabled: boolean;
  private readonly _failures: FailureEntry[] = [];
  private readonly _log:      DailyLogger;

  constructor(
    private readonly _configDir: string,
    private readonly _scheduler: Scheduler,
    private readonly _state:     State,
    private readonly _registry:  Registry,
    private readonly _version:   string,
    private readonly _trayColor?: string,
    private readonly _dashboardManager?: DashboardManager | null,
  ) {
    super();
    this._startupEnabled = isStartupEnabled(_configDir);
    this._log = new DailyLogger(path.join(_configDir, 'logs', 'tray'), 'tray');
  }

  private get _trayPidFile(): string {
    return path.join(this._configDir, 'config.tray-pid');
  }

  private _killByPid(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch { /* already dead */ }
  }

  private _writeTrayPid(pid: number): void {
    try { fs.writeFileSync(this._trayPidFile, String(pid), 'utf8'); } catch { /* ignore */ }
  }

  private _clearTrayPid(): void {
    try { fs.unlinkSync(this._trayPidFile); } catch { /* ignore */ }
  }

  private _killOrphanTray(): void {
    try {
      const raw = fs.readFileSync(this._trayPidFile, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && pid > 0) this._killByPid(pid);
    } catch { /* no PID file */ }
    this._clearTrayPid();
  }

  async start(): Promise<void> {
    // Kill any tray registered by a previous daemon session before spawning a new one.
    this._killOrphanTray();

    this._scheduler.on('job-finished', (ev: { id: string; exitCode: number; job: Job }) => {
      this._onJobFinished(ev);
    });
    // Synchronous exit hook: kills tray-go even when process.exit() is called directly
    // (e.g. via the `orch restart` CLI RPC path which bypasses trayManager.stop()).
    process.on('exit', () => {
      // Kill via in-memory reference first, then fall back to PID file.
      const pid = (this._tp && !this._tp.killed) ? this._tp.process.pid : undefined;
      if (pid) {
        this._killByPid(pid);
      } else {
        // _tp already null (e.g. killed by _scheduleRestart) — use PID file fallback.
        try {
          const raw = fs.readFileSync(this._trayPidFile, 'utf8').trim();
          const filePid = parseInt(raw, 10);
          if (!isNaN(filePid) && filePid > 0) this._killByPid(filePid);
        } catch { /* no PID file */ }
      }
      this._clearTrayPid();
    });
    await this._spawnTray();
  }

  async stop(): Promise<void> {
    if (this._restartTimer) {
      clearTimeout(this._restartTimer);
      this._restartTimer = null;
    }
    if (this._successTimer) {
      clearTimeout(this._successTimer);
      this._successTimer = null;
    }
    if (this._tp) {
      await this._tp.kill();
      this._tp = null;
    }
    this._clearTrayPid();
    this._log.close();
  }

  private _onJobFinished({ id, exitCode, job }: { id: string; exitCode: number; job: Job }): void {
    if (exitCode !== 0) {
      const now  = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const msg  = job.onExitCode?.[String(exitCode)] ?? null;
      if (this._failures.length >= MAX_FAILURES) this._failures.shift();
      this._failures.push({ id, label: job.label || id, exitCode, message: msg, time });
    } else {
      const idx = this._failures.findIndex((f) => f.id === id);
      if (idx !== -1) this._failures.splice(idx, 1);
      // Flash a green success icon for SUCCESS_FLASH_MS, then revert
      this._showSuccess = true;
      if (this._successTimer) clearTimeout(this._successTimer);
      this._successTimer = setTimeout(() => {
        this._showSuccess = false;
        this._successTimer = null;
        this._refresh();
      }, SUCCESS_FLASH_MS);
    }
    this._refresh();
  }

  private _refresh(): void {
    if (!this._tp || this._tp.killed) return;
    void this._tp.send({ type: 'set-menu', menu: this._buildMenu() });
  }

  private _buildMenu(): MenuSnapshot {
    const hasFailures = this._failures.length > 0;
    const icons   = getIcons(this._trayColor);
    const successIcons = getIcons(SUCCESS_ICON_COLOR);
    const icon =
      hasFailures      ? icons.error :
      this._showSuccess ? successIcons.idle :
      icons.idle;
    const tooltip = hasFailures
      ? `Orchestrator - ${this._failures.length} job(s) failed`
      : this._showSuccess
        ? 'Orchestrator - last job succeeded'
        : 'Orchestrator - all jobs OK';

    const items: MenuItemSnapshot[] = [];

    items.push({ id: 'header', type: 'normal', title: `Orchestrator v${this._version}`, enabled: false });
    items.push({ id: 'sep1',   type: 'separator', title: '', enabled: false });

    if (hasFailures) {
      items.push({ id: 'status', type: 'normal', title: `[fail] ${this._failures.length} job(s) failed`, enabled: false });
      items.push({ id: 'sep2',   type: 'separator', title: '', enabled: false });
      for (const f of [...this._failures].reverse()) {
        const label = f.message
          ? `[fail] ${f.label} (exit ${f.exitCode}) - ${f.message}  [${f.time}]`
          : `[fail] ${f.label} (exit ${f.exitCode})  [${f.time}]`;
        items.push({ id: `fail-${f.id}`, type: 'normal', title: label, enabled: false });
      }
      items.push({ id: 'ack-failures', type: 'normal', title: 'Acknowledge failures', enabled: true });
    } else if (this._showSuccess) {
      items.push({ id: 'status', type: 'normal', title: '[ok] Last job succeeded', enabled: false });
    } else {
      items.push({ id: 'status', type: 'normal', title: 'All jobs OK', enabled: false });
    }

    items.push({ id: 'sep3',             type: 'separator', title: '',               enabled: false });
    items.push({ id: 'open-dashboard',   type: 'normal',    title: 'Open Dashboard', enabled: this._dashboardManager != null });
    items.push({ id: 'open-logs',        type: 'normal',    title: 'Open logs',      enabled: true });
    items.push({ id: 'startup-toggle', type: 'normal',    title: 'Start at login', enabled: true, checked: this._startupEnabled });
    items.push({ id: 'sep4',           type: 'separator', title: '',             enabled: false });
    items.push({ id: 'restart',        type: 'normal',    title: 'Restart',      enabled: true });
    items.push({ id: 'quit',           type: 'normal',    title: 'Quit',         enabled: true });

    return { icon, isTemplateIcon: false, tooltip, items };
  }

  private async _spawnTray(): Promise<void> {
    const binaryPath = this._findBinary();
    if (!binaryPath) {
      console.warn('[tray] binary not found - systray disabled');
      return;
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }
    }

    const tp = new TrayProcess(binaryPath);
    this._tp = tp;

    tp.onStderrLine((line) => {
      this._log.write(`[tray-go] ${line}`);
      console.error(`[tray-go] ${line}`);
    });

    tp.onExit((code) => {
      this._log.write(`[tray] process exited with code=${code} stderr=${JSON.stringify(tp.capturedStderr().slice(-500))}`);
      this._tp = null;
      if (!this._intentionalStop && code !== 0 && code !== null) {
        this._scheduleRestart();
      }
    });

    tp.onError((err) => {
      this._log.write(`[tray] spawn error: ${getErrorMessage(err)}`);
      console.error(`[tray] spawn error: ${getErrorMessage(err)}`);
      this._tp = null;
      if (!this._intentionalStop) this._scheduleRestart();
    });

    tp.onClicked((id) => this._handleClick(id));

    try {
      await tp.ready();
      this._restartAttempt = 0;
      // Record PID so the next daemon session can kill this orphan on startup.
      if (tp.process.pid) this._writeTrayPid(tp.process.pid);
      this._log.write('[tray] ready, sending init');
      await tp.send({ type: 'init', menu: this._buildMenu() });
      this._log.write('[tray] init sent');
    } catch (err) {
      this._log.write(`[tray] failed to start: ${getErrorMessage(err)}`);
      console.error('[tray] failed to start:', getErrorMessage(err));
      this._tp = null;
      this._scheduleRestart();
    }
  }

  private _scheduleRestart(): void {
    if (this._restartTimer) return;
    const delay = Math.min(1000 * Math.pow(2, this._restartAttempt), 30_000);
    this._restartAttempt++;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this._spawnTray().catch((err: unknown) => {
        console.error('[tray] restart failed:', getErrorMessage(err));
      });
    }, delay);
  }

  private _findBinary(): string | null {
    // Try the platform package first (production install via optionalDependencies).
    if (_platformPkg) {
      try {
        return require.resolve(`${_platformPkg}/${PLATFORM_TRAY_BINARY}`);
      } catch {
        // Platform package not installed - fall through to local paths (dev/CI builds).
      }
    }
    // Fallback: local paths used during development or legacy installs.
    const candidates = [
      path.join(__dirname, TRAY_BINARY),
      path.join(__dirname, '..', 'tray-go', 'dist', TRAY_BINARY),
    ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }

  private _handleClick(id: string): void {
    switch (id) {
      case 'open-dashboard': {
        const dm = this._dashboardManager;
        if (dm) {
          if (!dm.isRunning()) {
            dm.start()
              .then(() => { setTimeout(() => dm.openBrowser(), 500); })
              .catch((err: unknown) => { console.error('[tray] failed to start dashboard server:', getErrorMessage(err)); });
          } else {
            dm.openBrowser();
          }
        }
        break;
      }
      case 'open-logs': {
        const logsDir = path.join(this._configDir, 'logs');
        const cmd = process.platform === 'win32' ? 'explorer.exe' : 'open';
        // violations-suppress: cli/daemon-spawn-no-windows-hide intentionally opens the file explorer as a visible window
        execFile(cmd, [logsDir], (err) => {
          if (err) console.error('[tray] open-logs failed:', getErrorMessage(err));
        });
        break;
      }
      case 'startup-toggle': {
        if (this._startupEnabled) {
          disableStartup(this._configDir);
          this._startupEnabled = false;
        } else {
          enableStartup(this._configDir);
          this._startupEnabled = true;
        }
        this._refresh();
        break;
      }
      case 'ack-failures':
        this._failures.length = 0;
        this._state.acknowledgeAll();
        this._refresh();
        break;
      case 'restart': {
        // Set flag BEFORE kill so onExit knows not to schedule a restart.
        const killAndRestart = async () => {
          this._intentionalStop = true;
          if (this._tp && !this._tp.killed) await this._tp.kill();
          this._tp = null;
          this.emit('restart');
        };
        void killAndRestart();
        break;
      }
      case 'quit': {
        const killAndQuit = async () => {
          this._intentionalStop = true;
          if (this._tp && !this._tp.killed) await this._tp.kill();
          this._tp = null;
          this.emit('quit');
        };
        void killAndQuit();
        break;
      }
      // violations-suppress: ts/no-switch-default-break unknown tray IDs from Go binary are intentionally ignored (forward-compat)
      default:
        break;
    }
  }
}
