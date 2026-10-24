import { StringDecoder } from 'node:string_decoder';

/**
 * A pipe cuts a program's output anywhere: inside an escape sequence (`ESC[3` then `1m`) or inside a multibyte
 * character. Stripping and decoding each chunk on its own left the halves behind (`3`, `1mred`, U+FFFD).
 *
 * One of these per stream turns chunks into lines for the run log. It holds back only what cannot be judged yet:
 * the bytes of a cut character, and the line that ends in an escape sequence which has not ended. Text is never held waiting for a
 * newline: a progress bar that redraws with `\r` and never prints one must still reach the log.
 */

// An escape sequence that has started and not ended, at the end of the text: ESC alone, a CSI without its final
// byte, an OSC/DCS/SOS/PM/APC string without BEL or ST, ESC plus intermediates without a final byte.
const OPEN_SEQUENCE_RE = /\u001b(?:\[[0-?]*[ -/]*|[\]PX^_][^\u0007\u001b]*\u001b?|[ -/]*)$/;

/** A sequence still open after this many characters is not one that will end: it is released as text. */
const MAX_HELD = 4096;

/** The longest unfinished line held back for an open sequence. */
const MAX_LINE_HELD = 65536;

export class OutputLines {
  private readonly _decoder = new StringDecoder('utf8');
  private _held = '';

  /** The lines this chunk completes or ends on (a trailing fragment without newline included, unless it is an open sequence). */
  push(chunk: string | Buffer): string[] {
    const text = this._held + (typeof chunk === 'string' ? chunk : this._decoder.write(chunk));
    this._held = '';
    const lines = text.split('\n');
    const last = lines.pop()!;
    const open = last.search(OPEN_SEQUENCE_RE);
    if (open !== -1 && last.length - open <= MAX_HELD && last.length <= MAX_LINE_HELD) {
      // The whole unfinished line: its first half must not be logged apart from the rest of it.
      this._held = last;
    } else {
      lines.push(last);
    }
    return lines;
  }

  /**
   * What is still held when the stream ends: the line that was waiting for its sequence to end, without that
   * sequence (it never will), and the bytes of a character that never completed.
   */
  flush(): string[] {
    let rest = this._held + this._decoder.end();
    this._held = '';
    const open = rest.search(OPEN_SEQUENCE_RE);
    if (open !== -1) {
      rest = rest.slice(0, open);
    }
    return rest === '' ? [] : [rest];
  }
}
