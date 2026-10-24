/**
 * Strips terminal escape sequences from text a job printed: colours and styles (SGR), cursor and erase codes,
 * OSC strings (window title, hyperlinks), DCS/APC/PM/SOS strings, and the short ESC sequences (reset, save and
 * restore cursor, charset selection). A carriage return is NOT an escape sequence and is left alone: a
 * progress bar that redraws with `\r` keeps its redraws.
 *
 * The one helper of the CLI side, for the run log files (scheduler, supervisor) and every CLI view of them.
 * The dashboard cannot import it (build chain) and keeps its own in dsl-lib-orch/src/strip-ansi.ts;
 * dsl-lib-orch/test/ansi-parity.test.ts runs both over test/ansi-cases.js. Change both together.
 * The supervisor (supervisor-go/run.go) strips the same way in Go for the lines it writes itself.
 */
const ANSI_RE = new RegExp([
  // OSC / DCS / SOS / PM / APC string, ended by BEL or ST (ESC \), or by the end of the line when it was cut.
  '\\u001b[\\]PX^_][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\|$)',
  // CSI: ESC [ parameters, intermediates, final byte. Covers SGR, cursor movement, erase, private modes.
  '\\u001b\\[[0-?]*[ -/]*[@-~]',
  // Any other ESC sequence: intermediates then a final byte (ESC c, ESC 7, ESC ( B ...).
  '\\u001b[ -/]*[0-~]',
  // An ESC that starts nothing.
  '\\u001b',
].join('|'), 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}
