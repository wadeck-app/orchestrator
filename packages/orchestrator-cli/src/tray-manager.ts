import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { DailyLogger } from './logger.js';
import { TrayProcess, type MenuSnapshot, type MenuItemSnapshot } from './tray-process.js';
import { getIcons } from './tray-icons.js';
import { enableStartup, disableStartup, isStartupEnabled } from './startup.js';
import { trayToRun, platformPackage } from './platform-binary.js';
import type { State } from './state.js';
import type { Registry } from './registry.js';
import { getErrorMessage } from './fsUtil.js';
import type { Scheduler } from './scheduler.js';
import type { Job } from './types.js';
import { isLongRunning } from './long-running.js';
import { isReleaseVersion, devBuildRefusalMessage } from './dev-build-guard.js';
import type { DashboardManager } from './dashboard-manager.js';

const MAX_FAILURES = 5;

/** A tray that dies more than this many times within RESTART_WINDOW_MS is not restarted again at full speed. */
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS      = 10 * 60_000;
const RESTART_BACKOFF_MAX_MS = 30_000;
/** After giving up, one new attempt this long afterwards: a tray that never comes back is worse than a rare retry. */
const RESTART_COOLDOWN_MS    = 30 * 60_000;

/** All tray action IDs that can be triggered programmatically (e.g. via `orch tray <action>`). */
export const TRAY_ACTIONS = [
  'open-dashboard',
  'open-logs',
  'startup-toggle',
  'ack-failures',
  'update-btn',      // check for update (version item click)
  'update-install',  // install available update and restart
  'restart',
  'quit',
] as const;
export type TrayActionId = typeof TRAY_ACTIONS[number];

interface FailureEntry {
  id:       string;
  label:    string;
  // Null for a run that ended without a code (timeout, resource limit): the menu says "exit null" for it.
  exitCode: number | null;
  message:  string | null;
  time:     string;
}

const SUCCESS_FLASH_MS = 5_000;
/** How long a job meant to run for ever (no timeout) is shown as running: long enough to see it start. */
const LONG_RUNNING_SHOWN_MS = 5_000;

type UpdateStatus = 'idle' | 'checking' | 'available' | 'up-to-date' | 'updating';

export class TrayManager extends EventEmitter {
  private _tp:               TrayProcess | null = null;
  private _spawning          = false;   // guard: prevent concurrent _spawnTray() calls
  private _intentionalStop   = false;  // true during kill-before-restart/quit; suppresses onExit restart
  /**
   * Set by stop() and never cleared: a stopped manager starts no tray, however its last start or its last tray ends. A tray
   * started (or restarted) after stop() is a child process with piped stdio, which keeps the daemon alive for ever.
   */
  private _stopped           = false;
  /** When the tray died, newest last, within RESTART_WINDOW_MS: the count the restart policy works from. */
  private _crashTimes:       number[] = [];
  private _restartTimer:     ReturnType<typeof setTimeout> | null = null;
  private _successTimer:   ReturnType<typeof setTimeout> | null = null;
  private _showSuccess     = false;
  private _runningJobIds   = new Set<string>();  // jobs currently executing, as far as the icon is concerned
  /** One timer per long-running job: when it fires the job stops counting for the icon. */
  private readonly _longRunningTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private _startupEnabled: boolean;
  private readonly _failures: FailureEntry[] = [];
  private readonly _log:      DailyLogger;
  private _updateStatus: UpdateStatus = 'idle';
  private _latestVersion: string | null = null;
  // Transient version label shown during check ("Checking...", "Up to date"); null -> show version string
  private _versionLabel: string | null = null;
  private _versionLabelTimer: ReturnType<typeof setTimeout> | null = null;

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
    this._log = new DailyLogger(path.join(_configDir, 'logs', 'app'), 'tray');
  }

  private get _trayPidFile(): string {
    return path.join(this._configDir, 'config.tray-pid');
  }

  /** The clock of the restart policy. Overridden by tests. */
  protected _now(): number {
    return Date.now();
  }

  /** Arms a timer. Overridden by tests, which record the delay instead of waiting for it. */
  protected _startTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
    return setTimeout(fn, ms);
  }

  /** Starts the tray process. Overridden by tests, which drive a fake by hand instead of running a binary. */
  protected _createTray(binaryPath: string): TrayProcess {
    return new TrayProcess(binaryPath);
  }

  private _killByPid(pid: number): void {
    try {
      if (process.platform === 'win32') {
        execFileSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch { /* already dead */ }
  }

  /**
   * True when the pid is a running tray binary. Checked before a pid read from a file is killed: the file can outlive its
   * tray by a reboot, and the number may belong to anything by then.
   */
  protected _isTrayPid(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        return /orchestrator-tray/i.test(out);
      }
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', windowsHide: true });
      return /orchestrator-tray/i.test(out);
    } catch {
      // tasklist/ps found nothing, or could not run: nothing that is known to be a tray, so nothing is killed.
      return false;
    }
  }

  /**
   * Ends the tray a previous daemon of THIS config dir left behind, found through the pid file it wrote.
   *
   * It used to kill every tray binary on the machine by image name. That also killed the trays of every other daemon
   * (a dev instance, the daemons the test suites start): a forced kill exits with code 1 and writes nothing, which the
   * owner of the tray logged as a crash and restarted, 199 times on 2026-10-24.
   */
  private _killStaleTray(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this._trayPidFile, 'utf8').trim();
    } catch {
      return;
    }
    const pid = parseInt(raw, 10);
    if (isNaN(pid) || pid <= 0) {
      this._logAction(`[tray] pid file ${this._trayPidFile} holds "${raw}", not a pid: ignored and removed`);
      return;
    }
    if (!this._isTrayPid(pid)) {
      this._logAction(`[tray] pid file names ${pid}, which is not a tray (gone, or reused): left alone`);
      return;
    }
    this._logAction(`[tray] killing the tray ${pid} a previous daemon of this config dir left behind`);
    this._killByPid(pid);
  }

  private _writeTrayPid(pid: number): void {
    try { fs.writeFileSync(this._trayPidFile, String(pid), 'utf8'); } catch { /* ignore */ }
  }

  private _clearTrayPid(): void {
    try { fs.unlinkSync(this._trayPidFile); } catch { /* ignore */ }
  }

  async start(): Promise<void> {
    // The only place ORCH_NO_TRAY is read. For development and tests: a daemon a test starts and then kills by force would
    // leave a ghost icon in the taskbar. Production never sets it, hence the line in the log.
    const noTray = process.env['ORCH_NO_TRAY'];
    if (noTray === '1') {
      this._logAction('[tray] tray disabled by ORCH_NO_TRAY=1 (development and tests only): no tray process is started');
      return;
    }
    if (noTray !== undefined && noTray !== '' && noTray !== '0') {
      this._logAction(`[tray] ORCH_NO_TRAY="${noTray}" ignored: only "1" disables the tray`);
    }
    // Kill the tray a previous daemon of this config dir left behind before spawning a fresh one.
    // Set intentionalStop FIRST so any onExit callbacks from the killed processes
    // don't schedule a restart (the new spawn below handles that).
    this._intentionalStop = true;
    this._killStaleTray();
    this._clearTrayPid();
    this._intentionalStop = false;

    this._scheduler.on('job-started', (ev: { id: string }) => { this._jobStarted(ev.id); });
    this._scheduler.on('job-finished', (ev: { id: string; exitCode: number | null; job: Job; skipped?: boolean; cancelledByUser?: boolean }) => {
      // Still running while any instance is: the first one to end must not clear the job from the
      // tray. The slot is released before this event, so the count is already the one after.
      if (this._scheduler.runningCount(ev.id) === 0) {
        this._jobEnded(ev.id);
      }
      this._onJobFinished(ev);
    });
    // Synchronous backup exit hook: ensures tray is killed even if triggerRestart()
    // was bypassed (e.g. direct process.exit() call from tests or edge cases).
    // When triggerRestart() ran correctly, _tp is already null and _intentionalStop is true.
    process.on('exit', () => {
      this._intentionalStop = true;
      // Only kill if the tray wasn't already gracefully killed by triggerRestart/triggerQuit.
      if (this._tp && !this._tp.killed) {
        const pid = this._tp.process.pid;
        if (pid) {
          this._killByPid(pid);
        }
      } else {
        // Fallback: read PID file in case _tp reference was lost.
        try {
          const raw = fs.readFileSync(this._trayPidFile, 'utf8').trim();
          const filePid = parseInt(raw, 10);
          if (!isNaN(filePid) && filePid > 0) {
            this._killByPid(filePid);
          }
        } catch { /* no PID file */ }
      }
      this._clearTrayPid();
    });
    await this._spawnTray();
  }

  /** Clear in-memory failure list and refresh the tray icon. Called when failures are acked from the UI. */
  clearFailures(): void {
    this._failures.length = 0;
    this._logAction('[tray] failures acknowledged (from UI)');
    this._refresh();
  }

  /** Gracefully kill the tray then emit 'restart'. Used by tray click AND CLI 'restart' command. */
  async triggerRestart(): Promise<void> {
    this._logAction('[tray] action: restart requested');
    this._intentionalStop = true;
    if (this._tp && !this._tp.killed) {
      await this._tp.kill();
    }
    this._tp = null;
    this._logAction('[tray] restarting daemon');
    this.emit('restart');
  }

  /** Gracefully kill the tray then emit 'quit'. Used by tray click AND CLI 'quit' command. */
  async triggerQuit(): Promise<void> {
    this._logAction('[tray] action: quit requested');
    this._intentionalStop = true;
    if (this._tp && !this._tp.killed) {
      await this._tp.kill();
    }
    this._tp = null;
    this._logAction('[tray] quitting daemon');
    this.emit('quit');
  }

  /**
   * Programmatically trigger a tray action by ID -- same as the user clicking it.
   * Used by `orch tray <action>` for scriptable / test automation.
   */
  triggerAction(id: string): { ok: boolean; error?: string } {
    if (!TRAY_ACTIONS.includes(id as TrayActionId)) {
      return { ok: false, error: `Unknown tray action "${id}". Valid actions: ${TRAY_ACTIONS.join(', ')}` };
    }
    this._handleClick(id);
    return { ok: true };
  }

  async stop(): Promise<void> {
    // First, before anything is killed: the exit of the tray we are about to kill (a forced kill ends with a failure
    // code on Windows) must not be taken for a crash, and a start still in flight must not retry.
    this._stopped = true;
    this._intentionalStop = true;
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

  private _onJobFinished({ id, exitCode, job, skipped, cancelledByUser }: {
    id: string; exitCode: number | null; job: Job; skipped?: boolean; cancelledByUser?: boolean;
  }): void {
    // A skipped run is neither a failure to badge nor a success to flash green: it did no work.
    if (skipped) {
      return;
    }
    // A run the user ended has no exit code and is not a failure (the history does not count it as one either). It
    // used to be listed here as "exit null", and ending a server by hand left the tray red with every job fine.
    if (cancelledByUser) {
      return;
    }
    if (exitCode !== 0) {
      const now  = new Date();
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const msg  = job.onExitCode?.[String(exitCode)] ?? null;
      if (this._failures.length >= MAX_FAILURES) {
        this._failures.shift();
      }
      this._failures.push({ id, label: job.label || id, exitCode, message: msg, time });
    } else {
      const idx = this._failures.findIndex((f) => f.id === id);
      if (idx !== -1) {
        this._failures.splice(idx, 1);
      }
      // Flash a green success icon for SUCCESS_FLASH_MS, then revert
      this._showSuccess = true;
      if (this._successTimer) {
        clearTimeout(this._successTimer);
      }
      this._successTimer = setTimeout(() => {
        this._showSuccess = false;
        this._successTimer = null;
        this._refresh();
      }, SUCCESS_FLASH_MS);
    }
    this._refresh();
  }

  private _refresh(): void {
    if (!this._tp || this._tp.killed) {
      return;
    }
    void this._tp.send({ type: 'set-menu', menu: this._buildMenu() });
  }

  // Log to tray log AND emit 'log' event so index.ts can forward to daemon log
  private _logAction(msg: string): void {
    this._log.write(msg);
    this.emit('log', msg);
  }

  private _setVersionLabel(label: string | null, revertAfterMs?: number): void {
    if (this._versionLabelTimer) { clearTimeout(this._versionLabelTimer); this._versionLabelTimer = null; }
    this._versionLabel = label;
    if (revertAfterMs != null) {
      this._versionLabelTimer = setTimeout(() => {
        this._versionLabel = null;
        this._versionLabelTimer = null;
        this._refresh();
      }, revertAfterMs);
    }
  }

  private async _checkForUpdate(): Promise<void> {
    // A development build can never equal a published version: it would claim an update for ever, and the
    // install row would lead to the updater, which refuses. Say so instead of checking.
    if (!isReleaseVersion(this._version)) {
      this._logAction(`[tray] check-update: ${devBuildRefusalMessage(this._version)}`);
      this._updateStatus = 'idle';
      this._setVersionLabel('Development build: no updates', 6_000);
      this._refresh();
      return;
    }
    this._logAction(`[tray] check-update: starting (current=${this._version})`);
    this._updateStatus = 'checking';
    this._setVersionLabel('Checking...');
    this._refresh();
    try {
      const latest = await new Promise<string>((resolve, reject) => {
        // Use shell:true so npm resolves correctly on all platforms (npm.cmd on Windows)
        execFile('npm', ['view', '@wadeck-app/orchestrator-cli', 'version', '--json'],
          { timeout: 15_000, shell: true, windowsHide: true }, (err, stdout) => {
            if (err) { reject(err); return; }
            try { resolve(JSON.parse(stdout.trim()) as string); }
            catch { reject(new Error('bad npm view output')); }
          });
      });
      this._latestVersion = latest;
      // Strip the display-only suffixes before comparing: the trailing git hash
      // ("2026.9.5-153-f4a6e93" -> "2026.9.5-153"), and the -local-dev marker a dev instance adds
      // to name itself in the tray. Without the second one a dev build would report an update
      // available forever, since its version can never equal what npm publishes.
      const normalize = (v: string) => v.replace(/-local-dev$/, '').replace(/-[0-9a-f]{6,8}$/, '');
      this._updateStatus = normalize(latest) !== normalize(this._version) ? 'available' : 'up-to-date';
      this._logAction(`[tray] check-update: latest=${latest} current=${this._version} status=${this._updateStatus}`);
      if (this._updateStatus === 'available') {
        this._setVersionLabel(null); // update item itself is the feedback
      }
    } catch (err) {
      this._logAction(`[tray] check-update: error fetching latest version: ${getErrorMessage(err)}`);
      this._updateStatus = 'idle';
      this._setVersionLabel(null);
    }
    // Flash green success icon when already up-to-date, then reset
    if (this._updateStatus === 'up-to-date') {
      this._setVersionLabel('Up to date', 4_000);
      this._showSuccess = true;
      if (this._successTimer) {
        clearTimeout(this._successTimer);
      }
      this._successTimer = setTimeout(() => {
        this._showSuccess = false;
        this._successTimer = null;
        this._updateStatus = 'idle';
        this._refresh();
      }, SUCCESS_FLASH_MS);
    }
    this._refresh();
  }

  /**
   * A job started. A job declared with no timeout (timeoutSeconds 0: "for a process that must stay up") is meant to run
   * for ever, so it is shown as running for a few seconds only: counted for ever, it would leave the icon blue on
   * every machine that has a server job, and a blue icon that is always blue says nothing.
   */
  private _jobStarted(id: string): void {
    this._runningJobIds.add(id);
    this._clearLongRunningTimer(id);
    const job = this._registry.get(id);
    if (job && isLongRunning(job)) {
      this._longRunningTimers.set(id, setTimeout(() => {
        this._longRunningTimers.delete(id);
        this._runningJobIds.delete(id);
        this._refresh();
      }, LONG_RUNNING_SHOWN_MS));
    }
    this._refresh();
  }

  /** The last instance of a job ended. */
  private _jobEnded(id: string): void {
    this._clearLongRunningTimer(id);
    this._runningJobIds.delete(id);
  }

  private _clearLongRunningTimer(id: string): void {
    const timer = this._longRunningTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this._longRunningTimers.delete(id);
    }
  }

  private _buildMenu(): MenuSnapshot {
    const hasFailures = this._failures.length > 0;
    const hasRunning  = this._runningJobIds.size > 0;
    const icons   = getIcons(this._trayColor);
    const updateAvailable = this._updateStatus === 'available';
    // Checking wins over everything below it. `npm view` takes a few seconds, and until this
    // existed the icon did not move at all between the click and the answer: the menu said
    // "Checking..." but the tray looked idle, so the click read as having done nothing.
    // It does not outrank failures, which are about the jobs rather than about this check.
    const busyChecking = this._updateStatus === 'checking' || this._updateStatus === 'updating';
    const icon =
      hasFailures       ? icons.error :
      busyChecking      ? icons.checking :
      updateAvailable   ? icons.error :
      this._showSuccess ? icons.success :
      hasRunning        ? icons.running :
      icons.idle;
    const tooltip = hasFailures
      ? `Orchestrator - ${this._failures.length} job(s) failed`
      : this._showSuccess
        ? 'Orchestrator - last job succeeded'
        : hasRunning
          ? `Orchestrator - ${this._runningJobIds.size} job(s) running`
          : 'Orchestrator - all jobs OK';

    const items: MenuItemSnapshot[] = [];

    // Header: app name + PIDs for Task Manager cross-reference
    const trayPid = this._tp?.process.pid ?? null;
    const pidSuffix = trayPid != null
      ? ` [orch:${process.ppid} node:${process.pid} tray:${trayPid}]`
      : ` [orch:${process.ppid} node:${process.pid}]`;
    items.push({ id: 'header',     type: 'normal', title: `Orchestrator${pidSuffix}`, enabled: false });

    // Version item -- clickable, doubles as the update-check trigger.
    // The hint is only added when clicking would actually start a check: during one the label is
    // "Checking...", and once an update is found the install item above is the action, so
    // "click to check" there would point at the wrong row.
    const versionTitle = this._versionLabel
      ?? (this._updateStatus === 'idle'
        ? `v${this._version} (click to check)`
        : `v${this._version}`);
    const versionEnabled = this._updateStatus !== 'checking' && this._updateStatus !== 'updating';
    items.push({ id: 'update-btn', type: 'normal', title: versionTitle, enabled: versionEnabled });

    // Config dir -- helps orient when multiple instances run
    const shortConfig = this._configDir.replace(/^\/c\/Users\/[^/]+/, '~').replace(/^C:\\Users\\[^\\]+/, '~');
    items.push({ id: 'config-dir', type: 'normal', title: `Config: ${shortConfig}`, enabled: false });

    // Update-available item (only shown when update is ready or installing)
    if (this._updateStatus === 'available') {
      items.push({ id: 'update-install', type: 'normal' as const, title: `Update to v${this._latestVersion ?? '?'} and restart`, enabled: true });
    } else if (this._updateStatus === 'updating') {
      items.push({ id: 'update-install', type: 'normal' as const, title: 'Updating...', enabled: false });
    }

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

    items.push({ id: 'sep3',           type: 'separator', title: '',               enabled: false });
    items.push({ id: 'open-dashboard', type: 'normal',    title: 'Open Dashboard', enabled: this._dashboardManager != null });
    items.push({ id: 'open-logs',      type: 'normal',    title: 'Open logs',      enabled: true });
    // Separator opens the system group, matching wdrive: the divider belongs above the group,
    // not inside it, so Start at login sits directly on top of Restart instead of being cut off
    // from the actions it belongs with.
    items.push({ id: 'sep4',           type: 'separator', title: '',               enabled: false });
    items.push({ id: 'startup-toggle', type: 'normal',    title: 'Start at login', enabled: true, checked: this._startupEnabled });
    items.push({ id: 'restart',        type: 'normal',    title: 'Restart',        enabled: true });
    items.push({ id: 'quit',           type: 'normal',    title: 'Quit',           enabled: true });

    return { icon, isTemplateIcon: false, tooltip, items };
  }

  private async _spawnTray(): Promise<void> {
    if (this._stopped) {
      this._logAction('[tray] _spawnTray() called after stop() - skipped');
      return;
    }
    if (this._spawning) {
      this._logAction('[tray] _spawnTray() called while already spawning - skipped');
      return;
    }
    this._spawning = true;
    const binaryPath = this._findBinary();
    if (!binaryPath) {
      this._spawning = false;
      // Goes through _logAction so it lands in the daemon log: the daemon's stdio is not
      // attached to a terminal, so a bare console.warn here disabled the tray silently.
      this._logAction(
        `[tray] systray disabled: binary not found. Expected in ${platformPackage() ?? `${process.platform}-${process.arch} (unsupported)`}`
        + ', or in tray-go/dist for a monorepo checkout. Re-install with: npm install -g @wadeck-app/orchestrator-cli',
      );
      return;
    }

    if (process.platform !== 'win32') {
      try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }
    }

    const tp = this._createTray(binaryPath);
    this._tp = tp;

    tp.onStderrLine((line) => {
      this._logAction(`[tray-go] ${line}`);
      console.error(`[tray-go] ${line}`);
    });

    tp.onExit((code, signal) => {
      // Everything captured, not its tail: the cause of a crash is as often at the start of the output as at its end.
      // A forced kill (exit code 1 on Windows, a signal on POSIX) writes nothing, and the line says so.
      const stderr = tp.capturedStderr();
      this._logAction(
        `[tray] process exited with code=${code} signal=${signal ?? 'none'} `
        + (stderr.length > 0 ? `stderr=${JSON.stringify(stderr)}` : 'no stderr (a tray that was killed from outside writes nothing)'),
      );
      this._tp = null;
      if (!this._intentionalStop && code !== 0 && code !== null) {
        this._scheduleRestart();
      }
    });

    tp.onError((err) => {
      this._logAction(`[tray] spawn error: ${getErrorMessage(err)}`);
      console.error(`[tray] spawn error: ${getErrorMessage(err)}`);
      this._tp = null;
      if (!this._intentionalStop) {
        this._scheduleRestart();
      }
    });

    tp.onStreamError((stream, err) => {
      this._logAction(`[tray] ${stream} of the tray process failed (${getErrorMessage(err)}): the tray is ended and restarted`);
    });
    tp.onSendFailed((reason) => {
      this._logAction(`[tray] could not send to the tray: ${reason}`);
    });

    tp.onClicked((id) => this._handleClick(id));

    try {
      await tp.ready();
      if (this._stopped) {
        // stop() came while the tray was starting and is killing it: nothing to initialise.
        return;
      }
      // Record PID so the next daemon session can kill this orphan on startup.
      if (tp.process.pid) {
        this._writeTrayPid(tp.process.pid);
      }
      this._logAction('[tray] ready, sending init');
      // Write init DIRECTLY and synchronously to stdin - this guarantees it arrives
      // before any message that may have been queued via tp.send() from other code paths.
      if (tp.writeNow({ type: 'init', menu: this._buildMenu() })) {
        this._logAction('[tray] init sent (direct write)');
      } else {
        this._logAction('[tray] init not sent: the tray cannot receive it (the reason is logged above)');
      }
    } catch (err) {
      if (this._stopped) {
        this._logAction(`[tray] start interrupted by stop(): ${getErrorMessage(err)}`);
        this._tp = null;
        return;
      }
      this._logAction(`[tray] failed to start: ${getErrorMessage(err)}`);
      console.error('[tray] failed to start:', getErrorMessage(err));
      // Explicitly kill the tray that failed to init so it doesn't linger as an orphan.
      if (tp.process.pid && !tp.killed) {
        this._killByPid(tp.process.pid);
      }
      this._tp = null;
      this._scheduleRestart();
    } finally {
      this._spawning = false;
    }
  }

  /**
   * A tray died: start another, with a bound. Back-off doubles with the number of deaths in the last ten minutes (a
   * tray reaches "ready" before anything can go wrong, so counting only restarts that never got ready is no bound at all),
   * and past MAX_RESTARTS_IN_WINDOW it stops, says so in the log, and tries once more after the cool-down.
   */
  private _scheduleRestart(): void {
    if (this._restartTimer || this._stopped) {
      return;
    }
    const now = this._now();
    this._crashTimes = this._crashTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    this._crashTimes.push(now);
    const crashes = this._crashTimes.length;
    let delay: number;
    if (crashes > MAX_RESTARTS_IN_WINDOW) {
      delay = RESTART_COOLDOWN_MS;
      this._crashTimes = [];
      this._logAction(
        `[tray] the tray process died ${crashes} times in ${RESTART_WINDOW_MS / 60_000} minutes, not restarting it now: `
        + `the daemon keeps running without a tray icon. Another attempt in ${RESTART_COOLDOWN_MS / 60_000} minutes; `
        + `run "orch restart" to try right away. Causes are in ${path.join(this._configDir, 'logs', 'app')} (tray-*.log, "process exited" lines).`,
      );
    } else {
      delay = Math.min(1000 * Math.pow(2, crashes - 1), RESTART_BACKOFF_MAX_MS);
      this._logAction(`[tray] restart ${crashes} of ${MAX_RESTARTS_IN_WINDOW} allowed in ${RESTART_WINDOW_MS / 60_000} minutes, in ${delay / 1000}s`);
    }
    this._restartTimer = this._startTimer(() => {
      this._restartTimer = null;
      this._spawnTray().catch((err: unknown) => {
        this._logAction(`[tray] restart failed: ${getErrorMessage(err)}`);
      });
    }, delay);
  }

  private _findBinary(): string | null {
    // Staged out of node_modules: a running tray there is one of the two images that make npm's
    // directory move fail during an update.
    return trayToRun(this._configDir);
  }

  private _handleClick(id: string): void {
    switch (id) {
      case 'open-dashboard': {
        this._logAction('[tray] action: open-dashboard');
        const dm = this._dashboardManager;
        if (dm) {
          if (!dm.isRunning()) {
            dm.start()
              .then(() => { setTimeout(() => dm.openBrowser(), 500); })
              .catch((err: unknown) => {
                const msg = getErrorMessage(err);
                this._logAction(`[tray] open-dashboard: failed to start server: ${msg}`);
                console.error('[tray] failed to start dashboard server:', msg);
              });
          } else {
            dm.openBrowser();
          }
        }
        break;
      }
      case 'open-logs': {
        this._logAction('[tray] action: open-logs');
        const logsDir = path.join(this._configDir, 'logs');
        if (process.platform === 'win32') {
          // Pass path without embedded quotes -- execFile is not a shell, quotes become literal backslashes.
          // violations-suppress: cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide intentionally opens the file explorer as a visible window
          execFile('cmd.exe', ['/c', 'start', '', logsDir], (err) => {
            if (err) {
              const msg = getErrorMessage(err);
              this._logAction(`[tray] open-logs: failed: ${msg}`);
              console.error('[tray] open-logs failed:', msg);
            }
          });
        } else {
          // violations-suppress: cli/daemon-spawn-no-windows-hide,cli/no-spawn-without-windows-hide macOS branch -- windowsHide has no meaning off Windows, and this opens Finder on purpose
          execFile('open', [logsDir], (err) => {
            if (err) {
              const msg = getErrorMessage(err);
              this._logAction(`[tray] open-logs: failed: ${msg}`);
              console.error('[tray] open-logs failed:', msg);
            }
          });
        }
        break;
      }
      case 'startup-toggle': {
        if (this._startupEnabled) {
          this._logAction('[tray] action: start-at-login disabled');
          const result = disableStartup(this._configDir);
          if (result.ok) {
            this._startupEnabled = false;
            this._logAction(`[tray] startup-toggle: disabled (${result.detail})`);
          } else {
            this._logAction(`[tray] startup-toggle: disable failed: ${result.error}`);
          }
        } else {
          this._logAction('[tray] action: start-at-login enabled');
          const result = enableStartup(this._configDir);
          if (result.ok) {
            this._startupEnabled = true;
            this._logAction(`[tray] startup-toggle: enabled (${result.detail})`);
            for (const w of result.warnings ?? []) {
              this._logAction(`[tray] startup-toggle: warning: ${w}`);
            }
          } else {
            this._logAction(`[tray] startup-toggle: enable failed: ${result.error}`);
          }
        }
        this._refresh();
        break;
      }
      case 'ack-failures':
        this._logAction(`[tray] action: acknowledge-failures (${this._failures.length} cleared)`);
        this._failures.length = 0;
        this._state.acknowledgeAll();
        this._refresh();
        break;
      case 'update-btn':
        // Version item doubles as check-update trigger
        if (this._updateStatus === 'idle' || this._updateStatus === 'up-to-date') {
          this._logAction('[tray] action: check-for-update clicked');
          void this._checkForUpdate();
        }
        break;
      case 'update-install':
        // Separate install item only shown when update is available
        if (this._updateStatus === 'available') {
          this._logAction(`[tray] action: update-and-restart clicked (target=${this._latestVersion ?? '?'})`);
          this._updateStatus = 'updating';
          this._refresh();
          this.emit('check-update');
        }
        break;
      case 'restart':
        this._logAction('[tray] action: restart clicked');
        void this.triggerRestart();
        break;
      case 'quit':
        this._logAction('[tray] action: quit clicked');
        void this.triggerQuit();
        break;
      // violations-suppress: ts/no-switch-default-break unknown tray IDs from Go binary are intentionally ignored (forward-compat)
      default:
        break;
    }
  }
}
