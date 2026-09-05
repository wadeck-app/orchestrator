import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

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
  private _sendQueue: Promise<void> = Promise.resolve();

  private static readonly STDERR_MAX_BYTES = 4096;

  constructor(binaryPath: string, env?: NodeJS.ProcessEnv) {
    this._readyPromise = new Promise<void>((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this.process = spawn(binaryPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env ?? process.env,
      windowsHide: true,
    });

    const rl = createInterface({ input: this.process.stdout! });
    rl.on('line', (line) => { this._handleLine(line); });

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
   * Sends a message to the tray process stdin.
   * Always awaits ready() first so no message can be written before the
   * process has signalled it is ready to receive.
   */
  async send(msg: StdinMessage): Promise<void> {
    const next = this._sendQueue.then(async () => {
      await this._readyPromise.catch(() => { /* fall through if ready already rejected */ });
      const line = JSON.stringify(msg) + '\n';
      await new Promise<void>((resolve, reject) => {
        this.process.stdin!.write(line, (err) => {
          if (err) reject(err); else resolve();
        });
      });
    });
    this._sendQueue = next.catch(() => {});
    return next;
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

    if (this.killed) return;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };

      const timer = setTimeout(() => {
        this.process.kill('SIGTERM');
        setTimeout(() => {
          if (!this.process.killed) this.process.kill('SIGKILL');
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
