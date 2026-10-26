/**
 * Copies what the daemon writes on its stdout and stderr into its log.
 *
 * Under the launcher the daemon has no console: with none, its stdio is the NUL device (kit launcher.go, openNulStdio), and
 * with one it is a terminal nobody keeps. So every console.error and process.stderr.write of the daemon was lost, among them
 * the lines that say a cron job "will NEVER fire". Patching the two streams, rather than the call sites, also catches Node's
 * own warnings and anything a dependency prints.
 *
 * The stream itself is untouched: its return value, its callback and what it prints on a terminal stay as they were.
 */

/** The part of a stream the bridge needs; process.stdout and process.stderr fit. */
export interface BridgedStreamLike {
  write: (...args: never[]) => boolean;
}

export interface BridgedStream {
  name:   string;
  stream: BridgedStreamLike;
}

export interface StdioBridge {
  /** Puts every original write back. Pending partial lines are dropped; call flush() first to keep them. */
  restore: () => void;
  /** Emits the partial line each stream is holding. */
  flush: () => void;
  /** Where lines go from now on: the early log first, the daemon log once it exists. */
  setSink: (sink: (line: string) => void) => void;
}

/** A stream that never writes a newline is emitted as a line past this many characters rather than held for ever. */
const MAX_PENDING_CHARS = 64 * 1024;

// eslint-disable-next-line no-control-regex
const ANSI_COLOUR = /\u001b\[[0-9;]*m/g;

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') {
    return chunk;
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString('utf8');
  }
  return '';
}

export function bridgeStdio(streams: BridgedStream[], initialSink: (line: string) => void): StdioBridge {
  let sink = initialSink;
  // Shared by both streams: the sink may itself write on one of them (DailyLogger reports its own failures on stderr), and
  // that line must not come back into the sink.
  let inSink = false;

  const emit = (name: string, line: string): void => {
    const clean = line.replace(ANSI_COLOUR, '').replace(/\r$/, '');
    if (clean === '' || inSink) {
      return;
    }
    inSink = true;
    try {
      sink(`[${name}] ${clean}`);
    } catch {
      // The log failing must never take the output down with it.
    } finally {
      inSink = false;
    }
  };

  const pending = new Map<string, string>();
  const originals = new Map<BridgedStreamLike, BridgedStreamLike['write']>();

  const feed = (name: string, text: string): void => {
    const lines = ((pending.get(name) ?? '') + text).split('\n');
    let rest = lines.pop() ?? '';
    for (const line of lines) {
      emit(name, line);
    }
    if (rest.length > MAX_PENDING_CHARS) {
      emit(name, rest);
      rest = '';
    }
    pending.set(name, rest);
  };

  for (const { name, stream } of streams) {
    const original = stream.write;
    originals.set(stream, original);
    stream.write = function patchedWrite(this: unknown, ...args: never[]): boolean {
      const result = (original as (...a: never[]) => boolean).apply(stream, args);
      try {
        if (!inSink) {
          feed(name, toText(args[0]));
        }
      } catch {
        // Same rule as the sink: never break the output.
      }
      return result;
    } as BridgedStreamLike['write'];
  }

  return {
    restore: () => {
      for (const [stream, original] of originals) {
        stream.write = original;
      }
    },
    flush: () => {
      for (const [name, rest] of pending) {
        if (rest !== '') {
          emit(name, rest);
        }
        pending.set(name, '');
      }
    },
    setSink: (next) => { sink = next; },
  };
}
