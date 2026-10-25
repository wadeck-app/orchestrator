import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { getErrorMessage } from './fsUtil.js';

// IPC protocol - Node -> Go (stdin):
//   { type: 'init',     menu: MenuSnapshot }
//   { type: 'set-menu', menu: MenuSnapshot }
//   { type: 'exit' }
//
// IPC protocol - Go -> Node (stdout):
//   { type: 'ready' }
//   { type: 'clicked', id: string }

export interface MenuItemSnapshot {
  id: string;
  type: 'normal' | 'separator';
  title: string;
  enabled: boolean;
  checked?: boolean;
}

export interface MenuSnapshot {
  icon: string;          // base64 PNG
  isTemplateIcon: boolean;
  tooltip: string;
  items: MenuItemSnapshot[];
}

type StdinMessage =
  | { type: 'init';     menu: MenuSnapshot }
  | { type: 'set-menu'; menu: MenuSnapshot }
  | { type: 'exit' };

// How long kill() waits for clean exit before escalating to SIGKILL.
const KILL_TIMEOUT_MS = 3000;

/**
 * TrayProcess wraps the tray-go child process.
 *
 * Lifecycle:
 *   1. Constructor spawns the binary.
 *   2. Caller awaits ready() before sending the first init message.
 *   3. Caller calls send() for init and subsequent set-menu messages.
 *   4. onClicked(cb) registers a handler for click events.
 *   5. kill() sends exit and waits up to 3 s for the process to stop.
 */
export class TrayProcess {
  readonly process: ChildProcess;

  private readonly _readyPromise: Promise<void>;
  private _readyResolve!: () => void;
  private _readyReject!: (err: Error) => void;
  private _readySettled = false;

  private readonly _emitter = new EventEmitter();
  private _stderrBuf = '';
  private _stderrRemainder = '';
  // Serialises send() calls so messages are always written in call order,
  // regardless of when ready() resolves. Without this, two concurrent callers
  // that both await a already-resolved ready() race on stdin.write().
  private _sendQueue: Promise<unknown> = Promise.resolve();
  // Set once the child's 'exit' was seen: from then on nothing is written to a pipe nobody reads.
  private _exited = false;
  // Each kind of failure is reported once per child: a dead tray makes every later menu update fail the same way.
  private _streamErrorReported = false;
  private _sendFailureReported = false;

  private static readonly STDERR_MAX_BYTES = 4096;

  constructor(binaryPath: string, env?: NodeJS.ProcessEnv, spawnFn: typeof spawn = spawn) {
    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // A tray that dies before it is ready rejects this promise, and a rejection nobody has awaited yet is an
    // unhandledRejection: a fatal one in the daemon. Callers still see the rejection through ready().
    this._readyPromise.catch(() => { /* observed by ready() callers; here it only must not be unhandled */ });

    this.process = spawnFn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
      windowsHide: true,
    });

    // A stream of a child that dies emits 'error' (EPIPE, ECONNRESET, ERR_STREAM_DESTROYED), and an 'error' with no
    // listener is an uncaughtException: it took the whole daemon down on 2026-10-25. Every stream has a listener, and
    // none of them throws. The tray exiting is reported by 'exit'; this only makes sure the pipe cannot kill the daemon.
    this.process.stdin?.on('error', (err) => { this._handleStreamError('stdin', err); });
    this.process.stdout?.on('error', (err) => { this._handleStreamError('stdout', err); });
    this.process.stderr?.on('error', (err) => { this._handleStreamError('stderr', err); });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => { this._handleLine(line); });
    rl.on('error', (err) => { this._handleStreamError('stdout', err); });

    this.process.stderr?.on('data', (chunk: Buffer) => {
      this._handleStderr(chunk.toString('utf8'));
    });

    this.process.on('error', (err) => {
      if (!this._readySettled) {
        this._readySettled = true;
        this._readyReject(err);
      }
      this._emitter.emit('process-error', err);
    });

    this.process.on('exit', (code, signal) => {
      this._exited = true;
      if (!this._readySettled) {
        this._readySettled = true;
        this._readyReject(new Error(`tray process exited before ready (code=${code})`));
      }
      this._emitter.emit('exit', code, signal);
    });
  }

  private _handleLine(line: string): void {
    let msg: { type: string; id?: string };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      if (!this._readySettled) {
        this._readySettled = true;
        this._readyResolve();
      }
    } else if (msg.type === 'clicked' && msg.id !== undefined) {
      this._emitter.emit('clicked', msg.id);
    }
  }

  private _handleStderr(text: string): void {
    this._stderrBuf = (this._stderrBuf + text).slice(-TrayProcess.STDERR_MAX_BYTES);
    this._stderrRemainder += text;
    const lines = this._stderrRemainder.split('\n');
    this._stderrRemainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim().length > 0) {
        this._emitter.emit('stderr-line', line.trim());
      }
    }
  }

  /** Resolves when the tray process has emitted its "ready" message. */
  ready(): Promise<void> {
    return this._readyPromise;
  }

  /**
   * A pipe of the child failed. Reported once, then the child is ended if it is still there: a tray whose pipe is broken
   * can no longer be updated or heard, and ending it lets the manager start one that works.
   */
  private _handleStreamError(stream: 'stdin' | 'stdout' | 'stderr', err: Error): void {
    if (this._streamErrorReported) {
      return;
    }
    this._streamErrorReported = true;
    this._emitter.emit('stream-error', stream, err);
    if (!this._exited && this.process.exitCode === null) {
      try {
        this.process.kill();
      } catch { /* already gone: the exit event follows */ }
    }
  }

  private _reportSendFailure(reason: string): void {
    if (this._sendFailureReported) {
      return;
    }
    this._sendFailureReported = true;
    this._emitter.emit('send-failed', reason);
  }

  /** Why nothing can be written to the child, or null when its stdin looks usable. */
  private _stdinProblem(): string | null {
    const stdin = this.process.stdin;
    if (this._exited) {
      return `the tray process has exited (code=${this.process.exitCode})`;
    }
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return 'the tray process stdin is closed';
    }
    return null;
  }

  /**
   * Writes one message and says whether it was accepted by the pipe. Never throws and never rejects: a tray that died
   * is a fact to report, not an exception for a caller that only wanted to refresh a menu.
   */
  private _write(msg: StdinMessage): Promise<boolean> {
    const problem = this._stdinProblem();
    if (problem !== null) {
      this._reportSendFailure(problem);
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      try {
        this.process.stdin!.write(JSON.stringify(msg) + '\n', (err) => {
          if (err) {
            this._reportSendFailure(getErrorMessage(err));
            resolve(false);
          } else {
            resolve(true);
          }
        });
      } catch (err) {
        this._reportSendFailure(getErrorMessage(err));
        resolve(false);
      }
    });
  }

  /**
   * Sends a message to the tray process stdin.
   * Always awaits ready() first so no message can be written before the
   * process has signalled it is ready to receive.
   * Resolves true when the pipe took the message, false when the tray cannot receive it (reported once through
   * onSendFailed). Never rejects.
   */
  async send(msg: StdinMessage): Promise<boolean> {
    const next = this._sendQueue.then(async () => {
      await this._readyPromise.catch(() => { /* fall through if ready already rejected */ });
      return this._write(msg);
    });
    this._sendQueue = next;
    return next as Promise<boolean>;
  }

  /**
   * Writes a message now, outside the send() queue: for the init message, which must reach the tray before anything
   * queued behind ready(). Returns false (and reports it once) when the tray cannot receive it. Never throws.
   */
  writeNow(msg: StdinMessage): boolean {
    const problem = this._stdinProblem();
    if (problem !== null) {
      this._reportSendFailure(problem);
      return false;
    }
    void this._write(msg);
    return true;
  }

  onClicked(cb: (id: string) => void): void {
    this._emitter.on('clicked', cb);
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this._emitter.on('exit', cb);
  }

  onError(cb: (err: Error) => void): void {
    this._emitter.on('process-error', cb);
  }

  /** A pipe of the child failed: which one and why. Called at most once per child. */
  onStreamError(cb: (stream: string, err: NodeJS.ErrnoException) => void): void {
    this._emitter.on('stream-error', cb);
  }

  /** The tray could not take a message: the reason. Called at most once per child. */
  onSendFailed(cb: (reason: string) => void): void {
    this._emitter.on('send-failed', cb);
  }

  onStderrLine(cb: (line: string) => void): void {
    this._emitter.on('stderr-line', cb);
  }

  capturedStderr(): string {
    return this._stderrBuf;
  }

  get killed(): boolean {
    return this.process.killed || this.process.exitCode !== null;
  }

  async kill(): Promise<void> {
    try {
      await this.send({ type: 'exit' });
    } catch { /* ignore - process may already be dead */ }

    if (this.killed) {
      return;
    }

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timer = setTimeout(() => {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (!this.process.killed) {
            this.process.kill('SIGKILL');
          }
          finish();
        }, 500);
      }, KILL_TIMEOUT_MS);

      this._emitter.once('exit', () => {
        clearTimeout(timer);
        finish();
      });
    });
  }
}
