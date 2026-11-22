/**
 * The real effects behind the watchdog loop (see watchdog.ts) and the small pure helpers of its entry point. No side effect at
 * import time: main.ts is the only module that does something when loaded.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { WATCHDOG_PID_ENV } from './pid-watch.js';
import type { DaemonHandle, WatchdogFs, WatchdogLog } from './watchdog.js';

// Set in the daemon's environment on Windows: the daemon stops by itself when this pid is gone (see pid-watch.ts).
export { WATCHDOG_PID_ENV };
export const LAUNCHER_PID_FILE = 'config.launcher-pid';
/** Set by the npm shim for the Go launcher; honoured here too so a test or a checkout can name the bundle. */
export const BUNDLE_OVERRIDE_ENV = 'LAUNCHER_BUNDLE_OVERRIDE';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The config dir named by the arguments, same rules as the Go launcher's main.go.tmpl: `--config <dir>`, `--config=<dir>`, or
 * the first argument that is not a flag. Null when none is given.
 */
export function configDirFromArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config' && i + 1 < args.length) {
      return args[i + 1]!;
    }
    if (arg.startsWith('--config=')) {
      return arg.slice('--config='.length);
    }
  }
  return args.find((arg) => !arg.startsWith('--')) ?? null;
}

/** ~/.config/orchestrator, or $XDG_CONFIG_HOME/orchestrator (the Go launcher's DefaultConfigDir). */
export function defaultConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  const xdg = env['XDG_CONFIG_HOME'];
  return xdg !== undefined && xdg !== '' ? path.join(xdg, 'orchestrator') : path.join(home, '.config', 'orchestrator');
}

// ---------------------------------------------------------------------------
// Bundle and environment
// ---------------------------------------------------------------------------

/**
 * The daemon bundle: LAUNCHER_BUNDLE_OVERRIDE when set (an error when it is not a file), else dist/orchestrator.cjs next to this
 * watchdog bundle. Called at every (re)start, never cached: an update replaces the file under the same path.
 */
export function resolveDaemonBundle(opts: { env: NodeJS.ProcessEnv; dir: string; isFile: (file: string) => boolean }): string {
  const override = (opts.env[BUNDLE_OVERRIDE_ENV] ?? '').trim();
  if (override !== '') {
    if (opts.isFile(override)) {
      return override;
    }
    throw new Error(`${BUNDLE_OVERRIDE_ENV} points at "${override}", which is not a file: unset it, or point it at a daemon bundle (orchestrator.cjs)`);
  }
  const bundle = path.join(opts.dir, 'orchestrator.cjs');
  if (opts.isFile(bundle)) {
    return bundle;
  }
  throw new Error(`cannot find the daemon bundle ${bundle}, expected next to the watchdog: reinstall with: npm install -g @wadeck-app/orchestrator-cli`);
}

export function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * The daemon's environment: ours, with ORCH_CONFIG_DIR naming the config dir the watchdog works on (the daemon ignores the
 * positional argument) and, on Windows only, the watchdog pid. Elsewhere an inherited ORCH_WATCHDOG_PID is removed: it would
 * name some other watchdog.
 */
export function daemonEnv(base: NodeJS.ProcessEnv, opts: { configDir: string; platform: NodeJS.Platform; watchdogPid: number }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ORCH_CONFIG_DIR: opts.configDir };
  if (opts.platform === 'win32') {
    env[WATCHDOG_PID_ENV] = String(opts.watchdogPid);
  } else {
    delete env[WATCHDOG_PID_ENV];
  }
  return env;
}

/**
 * Where the daemon's stdout and stderr go (the Go launcher's rule): the watchdog's own when they are usable, the null device when
 * the watchdog has none (started with stdio 'ignore' by `orch start`, where the daemon's console output is copied into its log).
 */
export function daemonStdio(fstat: (fd: number) => unknown = fs.fstatSync): 'inherit' | 'ignore' {
  try {
    fstat(0);
    fstat(1);
    fstat(2);
    return 'inherit';
  } catch {
    return 'ignore';
  }
}

// ---------------------------------------------------------------------------
// Log: same file, same line format as the Go launcher (logger.go)
// ---------------------------------------------------------------------------

const pad2 = (n: number): string => String(n).padStart(2, '0');
export const logDay = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** `[HH:MM:SS] [ INFO] [launcher] message` (local time; level padded to 5). */
export function formatLogLine(d: Date, level: 'INFO' | 'WARN' | 'ERROR', message: string): string {
  return `[${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}] [${level.padStart(5)}] [launcher] ${message}\n`;
}

export interface LogIo {
  now(): Date;
  mkdirp(dir: string): void;
  append(file: string, text: string): void;
  stderr(text: string): void;
  tmpdir(): string;
}

export const realLogIo: LogIo = {
  now: () => new Date(),
  mkdirp: (dir) => { fs.mkdirSync(dir, { recursive: true }); },
  append: (file, text) => { fs.appendFileSync(file, text); },
  stderr: (text) => { try { process.stderr.write(text); } catch { /* no stderr: the file has it */ } },
  tmpdir: () => os.tmpdir(),
};

/**
 * Writes <configDir>/logs/YYYY-MM-DD-launcher.log and stderr. When the file cannot be written (or there is no config dir) the line
 * goes to <tmp>/orchestrator-launcher-fallback.log with the reason: a line is never dropped.
 */
export function createLogger(configDir: string | null, io: LogIo = realLogIo): WatchdogLog {
  const write = (level: 'INFO' | 'WARN' | 'ERROR', message: string): void => {
    const now = io.now();
    const line = formatLogLine(now, level, message);
    const fallback = (prefix: string): void => {
      try {
        io.append(path.join(io.tmpdir(), 'orchestrator-launcher-fallback.log'), `${prefix}${line}`);
      } catch { /* nowhere left to write: stderr below has it */ }
    };
    if (configDir === null || configDir === '') {
      fallback('');
    } else {
      try {
        const dir = path.join(configDir, 'logs');
        io.mkdirp(dir);
        io.append(path.join(dir, `${logDay(now)}-launcher.log`), line);
      } catch (e) {
        fallback(`openLogFile failed (configDir=${JSON.stringify(configDir)}): ${errText(e)}\n`);
      }
    }
    io.stderr(line);
  };
  return { info: (m) => write('INFO', m), warn: (m) => write('WARN', m), error: (m) => write('ERROR', m) };
}

// ---------------------------------------------------------------------------
// Real file system and pid file
// ---------------------------------------------------------------------------

export const realFs: WatchdogFs = {
  exists: (file) => {
    try {
      fs.statSync(file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw e;
    }
  },
  readText: (file) => fs.readFileSync(file, 'utf8'),
  writeExclusive: (file, body) => { fs.writeFileSync(file, body, { flag: 'wx' }); },
  writeFile: (file, body) => { fs.writeFileSync(file, body); },
  rename: (from, to) => { fs.renameSync(from, to); },
  remove: (file) => { fs.rmSync(file, { force: true }); },
};

/** config.launcher-pid: the watchdog pid, decimal, no newline (the Go launcher's format). Removed only if it is still ours. */
export function createPidFile(configDir: string, pid: number, io: Pick<WatchdogFs, 'readText' | 'remove' | 'writeFile'> = realFs): { write(): void; remove(): void } {
  const file = path.join(configDir, LAUNCHER_PID_FILE);
  return {
    write: () => { io.writeFile(file, String(pid)); },
    remove: () => {
      let content: string;
      try {
        content = io.readText(file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          return;
        }
        throw e;
      }
      if (content.trim() === String(pid)) {
        io.remove(file);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Stop signals
// ---------------------------------------------------------------------------

/**
 * Tracks a stop request (SIGINT, SIGTERM, SIGBREAK) and the daemon it concerns. POSIX forwards the signal to the daemon; Windows
 * cannot (Node has no signal delivery to another process there), so the daemon keeps running and the log names the stop that works.
 * Either way the request is remembered: nothing is restarted afterwards.
 */
export class StopController {
  private requested = false;
  private child: ChildProcess | null = null;
  private wake: Array<() => void> = [];

  constructor(private readonly platform: NodeJS.Platform, private readonly log: WatchdogLog) {}

  get stopRequested(): boolean {
    return this.requested;
  }

  attach(child: ChildProcess | null): void {
    this.child = child;
  }

  onSignal(signal: NodeJS.Signals): void {
    this.requested = true;
    for (const w of this.wake.splice(0)) {
      w();
    }
    const child = this.child;
    if (child === null) {
      return;
    }
    if (this.platform === 'win32') {
      this.log.warn(`could not forward the ${signal} signal to the daemon: Windows has no signal forwarding; the daemon is still running and the `
        + 'watchdog keeps waiting for it: stop it with its own quit command (orch stop), not with a signal');
      return;
    }
    let sent = false;
    try {
      sent = child.kill(signal);
    } catch (e) {
      this.log.warn(`could not forward the ${signal} signal to the daemon: ${errText(e)}`);
      return;
    }
    if (!sent) {
      this.log.warn(`could not forward the ${signal} signal to the daemon (pid ${child.pid ?? 'unknown'}): it is already gone`);
    }
  }

  /** Waits `ms`; true as soon as a stop is requested (also when it already was), false when the delay elapsed. */
  sleep(ms: number): Promise<boolean> {
    if (this.requested) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = this.wake.filter((w) => w !== onStop);
        resolve(false);
      }, ms);
      const onStop = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.wake.push(onStop);
    });
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/** Starts `node <bundle> <args...>`: no window, cwd inherited. Rejects when the process cannot be created. */
export function spawnDaemon(opts: {
  nodePath: string; bundle: string; args: readonly string[]; env: NodeJS.ProcessEnv; stdio: 'inherit' | 'ignore';
  stop: StopController; log: WatchdogLog;
}): Promise<DaemonHandle> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.nodePath, [opts.bundle, ...opts.args], { stdio: opts.stdio, windowsHide: true, env: opts.env });
    const onSpawnError = (err: Error): void => { reject(err); };
    child.once('error', onSpawnError);
    child.once('spawn', () => {
      child.removeListener('error', onSpawnError);
      // After the start an 'error' event is a failed kill or a failed message: the exit event still tells how it ended.
      child.on('error', (err) => { opts.log.warn(`daemon process error: ${errText(err)}`); });
      opts.stop.attach(child);
      const exited = new Promise<{ code: number }>((done) => {
        // 'exit', not 'close': a grandchild (tray) holding a copy of an inherited handle must not delay the verdict.
        child.once('exit', (code) => {
          opts.stop.attach(null);
          done({ code: code ?? -1 });
        });
      });
      resolve({ pid: child.pid ?? -1, exited, wasSignalled: () => opts.stop.stopRequested });
    });
  });
}
