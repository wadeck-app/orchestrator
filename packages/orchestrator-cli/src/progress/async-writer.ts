import fs from 'node:fs';
import path from 'node:path';
import { getErrorMessage } from '../fsUtil.js';
import { systemTime, type TimeService } from '../time-service.js';

/*
 * Writes the learned-data files without ever blocking the daemon's event loop.
 *
 * fsUtil.atomicWriteJson retries a failing write after a busy-wait of 100 ms then 200 ms: called from get-progress it
 * froze every other request of the daemon for up to 300 ms. This writer has the same atomicity (a tmp file, then a
 * rename over the target) and the same 3 attempts, but write() returns at once, the disk work is promise based, and a
 * retry waits on a timer of the injected TimeService.
 *
 * Writes to one file are serialised, and content queued behind a running write is coalesced (the newest wins): the
 * learned data is derived and rewritten whole each time. pending() hands back the newest content that is not on disk
 * yet, so a reader that comes in right after a write sees it (read-your-writes) without waiting.
 */

export interface WriterFs {
  mkdir(dir: string): Promise<void>;
  writeFile(file: string, content: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

const realFs: WriterFs = {
  mkdir: async (dir) => { await fs.promises.mkdir(dir, { recursive: true }); },
  writeFile: (file, content) => fs.promises.writeFile(file, content, { encoding: 'utf8', flag: 'w', mode: 0o600 }),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (file) => fs.promises.unlink(file),
};

export interface JsonWriter {
  /** Queues the write and returns. `onFail` is called once, later, if every attempt failed. */
  write(file: string, data: unknown, onFail: (err: Error) => void): void;
  /** The newest content queued or being written for `file`, parsed; undefined once it is on disk (or failed). */
  pending(file: string): unknown;
  /** Resolves when nothing is queued or being written (and the retry waits are over). */
  whenIdle(): Promise<void>;
}

export interface JsonWriterOptions {
  fs?: WriterFs;
  time?: TimeService;
  attempts?: number;
  /** Wait before attempt n+1 is `backoffMs * 2^(n-1)`. */
  backoffMs?: number;
}

interface Slot {
  /** Serialised at write() time: later changes to the caller's object cannot leak in. */
  content: string;
  onFail: (err: Error) => void;
}

interface FileState {
  running: boolean;
  queued?: Slot;
  /** What a reader should see until the disk has it: the queued or in-flight content. */
  visible?: string;
}

export function createJsonWriter(options: JsonWriterOptions = {}): JsonWriter {
  const io = options.fs ?? realFs;
  const time = options.time ?? systemTime;
  const attempts = options.attempts ?? 3;
  const backoffMs = options.backoffMs ?? 100;
  const files = new Map<string, FileState>();
  const idleWaiters: Array<() => void> = [];

  const wait = (ms: number): Promise<void> => new Promise<void>(resolve => { time.after(ms, resolve); });

  const attempt = async (file: string, content: string): Promise<void> => {
    const tmp = `${file}.tmp`;
    try {
      await io.mkdir(path.dirname(file));
      await io.writeFile(tmp, content);
      await io.rename(tmp, file);
    } catch (err) {
      try { await io.unlink(tmp); } catch { /* the tmp file may not exist */ }
      throw err;
    }
  };

  const save = async (file: string, slot: Slot): Promise<void> => {
    let last: unknown;
    for (let n = 1; n <= attempts; n++) {
      try {
        await attempt(file, slot.content);
        return;
      } catch (err) {
        last = err;
        if (n < attempts) {
          await wait(backoffMs * 2 ** (n - 1));
        }
      }
    }
    slot.onFail(new Error(`Failed to write ${file} after ${attempts} attempts: ${getErrorMessage(last)}`));
  };

  const pump = async (file: string, state: FileState): Promise<void> => {
    state.running = true;
    try {
      for (let slot = state.queued; slot !== undefined; slot = state.queued) {
        state.queued = undefined;
        state.visible = slot.content;
        await save(file, slot);
        // A newer write queued meanwhile stays visible; otherwise the disk is current (or the write was reported failed).
        state.visible = state.queued ? (state.queued as Slot).content : undefined;
      }
    } finally {
      state.running = false;
      if (state.queued === undefined) {
        files.delete(file);
      }
      if (files.size === 0) {
        for (const resolve of idleWaiters.splice(0)) {
          resolve();
        }
      }
    }
  };

  return {
    write(file, data, onFail) {
      const state = files.get(file) ?? { running: false };
      files.set(file, state);
      const content = JSON.stringify(data, null, 2);
      state.queued = { content, onFail };
      state.visible = content;
      if (!state.running) {
        void pump(file, state);
      }
    },

    pending(file) {
      const content = files.get(file)?.visible;
      return content === undefined ? undefined : JSON.parse(content);
    },

    whenIdle() {
      return files.size === 0 ? Promise.resolve() : new Promise<void>(resolve => { idleWaiters.push(resolve); });
    },
  };
}

/** The daemon's writer: the real disk and the real clock. */
export const progressWriter: JsonWriter = createJsonWriter();
