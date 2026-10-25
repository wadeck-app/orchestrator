import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';

/**
 * What the daemon does with an error nobody caught.
 *
 * Policy: an uncaught exception or rejection is fatal. The daemon writes why, leaves a marker for `orch status`, and
 * exits 1; carrying on in a state nobody understands is worse than a restart (the launcher restarts it, within a bound).
 *
 * One class is never fatal: the peer of a pipe or socket went away. The operation that hit it failed on its own, and
 * nothing about the daemon's own state is unknown. On 2026-10-25 the tray's pipe closed, the EPIPE had no listener, and
 * the daemon exited and stayed down for 47 minutes.
 */

/** Written next to config.port when the daemon dies of an uncaught error; read by `orch status`; cleared at the next start. */
export const CRASH_MARKER_FILE = 'crashed.json';

const PEER_GONE_CODES: ReadonlySet<string> = new Set([
  'EPIPE', 'ECONNRESET', 'ECONNABORTED', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END',
]);

/** True for an error that only says "the other end of this pipe or socket is gone". */
export function isPeerGoneError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return typeof code === 'string' && PEER_GONE_CODES.has(code);
}

const SPAWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  'EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM', 'EACCES', 'EPERM', 'ENOENT',
]);

/**
 * True for the 'error' event of a child that could not be started (the process table or the handle limit is full, the
 * executable is missing or not executable). It reaches the process handler only when some code started a child without
 * an error listener, a library's `spawn` for instance; the child is what failed, not the daemon. Only a `spawn` syscall
 * counts: ENOENT from `open` is the daemon missing a file it needs.
 */
export function isChildSpawnFailure(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const { code, syscall } = err as NodeJS.ErrnoException;
  return typeof code === 'string' && SPAWN_FAILURE_CODES.has(code) && typeof syscall === 'string' && syscall.startsWith('spawn');
}

export interface CrashMarker {
  time:    string;
  kind:    string;
  error:   string;
  stack?:  string;
  version: string;
  pid:     number;
}

export interface FatalDeps {
  configDir: string;
  version:   string;
  /** Must write synchronously: the process exits right after. */
  log:       (line: string) => void;
  closeLog:  () => void;
  exit:      (code: number) => void;
}

function describe(reason: unknown): { message: string; stack?: string } {
  const message = getErrorMessage(reason);
  return reason instanceof Error && reason.stack ? { message, stack: reason.stack } : { message };
}

/** Never throws: a marker that cannot be written is said in the log, and the exit goes on. */
export function writeCrashMarker(deps: FatalDeps, kind: string, reason: unknown): void {
  const { message, stack } = describe(reason);
  const marker: CrashMarker = {
    time: new Date().toISOString(), kind, error: message, ...(stack ? { stack } : {}), version: deps.version, pid: process.pid,
  };
  try {
    fs.writeFileSync(path.join(deps.configDir, CRASH_MARKER_FILE), JSON.stringify(marker, null, 2));
  } catch (err) {
    deps.log(`could not write the crash marker ${CRASH_MARKER_FILE} in ${deps.configDir}: ${getErrorMessage(err)} (orch status will not report this crash)`);
  }
}

/**
 * The handler for 'uncaughtException' and 'unhandledRejection'. `label` is appended to the kind in the log line
 * (the early handlers, installed before the logger exists, say "pre-init").
 */
export function makeFatalHandler(
  kind: 'uncaughtException' | 'unhandledRejection', deps: FatalDeps, label = '',
): (reason: unknown) => void {
  return (reason: unknown): void => {
    const { message, stack } = describe(reason);
    const peerGone = isPeerGoneError(reason);
    if (peerGone || isChildSpawnFailure(reason)) {
      deps.log(
        `${kind} ignored, not fatal: `
        + (peerGone ? 'a pipe or socket was closed by its other end' : 'a child process could not be started')
        + ` (${message}). The operation that hit it failed; the daemon goes on.`,
      );
      if (stack) {
        deps.log(stack);
      }
      return;
    }
    deps.log(`daemon crash (${kind}${label}): ${message}`);
    if (stack) {
      deps.log(stack);
    }
    writeCrashMarker(deps, kind, reason);
    deps.closeLog();
    deps.exit(1);
  };
}

/** The marker of the last crash, or null. A marker that cannot be read is an error, not "no crash". */
export function readCrashMarker(configDir: string): CrashMarker | null {
  const file = path.join(configDir, CRASH_MARKER_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`cannot read ${file}: ${getErrorMessage(err)}`);
  }
  try {
    return JSON.parse(raw) as CrashMarker;
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${getErrorMessage(err)}); delete it`);
  }
}

export function clearCrashMarker(configDir: string): void {
  try {
    fs.unlinkSync(path.join(configDir, CRASH_MARKER_FILE));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`cannot remove ${path.join(configDir, CRASH_MARKER_FILE)}: ${getErrorMessage(err)}`);
    }
  }
}

/**
 * Makes the daemon's console output unable to kill it. The launcher's pipes can close while the daemon runs (a hidden
 * window), and any console write then fails with EPIPE or worse. Whatever the code, an error on stdout/stderr is logged
 * once per kind and swallowed: console output is a convenience, never a reason to exit.
 */
export function guardStdio(
  streams: Array<{ name: string; stream: NodeJS.EventEmitter }>, log: (line: string) => void,
): void {
  for (const { name, stream } of streams) {
    const seen = new Set<string>();
    stream.on('error', (err: NodeJS.ErrnoException) => {
      const code = typeof err.code === 'string' ? err.code : getErrorMessage(err);
      if (seen.has(code)) {
        return;
      }
      seen.add(code);
      log(`${name} error ${code} (${getErrorMessage(err)}): console output may be lost from now on; the daemon keeps running`);
    });
  }
}
