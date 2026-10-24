/**
 * Strips terminal escape sequences (colours, cursor and erase codes, OSC strings, short ESC sequences) from a log
 * line a job printed: the log pane paints with its own palette. A carriage return is left alone.
 *
 * The CLI strips the same way with its own copy, `stripAnsi` in orchestrator-cli/src/ansi.ts (dsl-lib-orch cannot
 * import the CLI). test/ansi-parity.test.ts fails if the two diverge; change both together.
 */
const ESCAPE_SEQUENCE_RE = new RegExp([
  // OSC / DCS / SOS / PM / APC string, ended by BEL or ST (ESC \), or by the end of the line when it was cut.
  '\\u001b[\\]PX^_][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\|$)',
  // CSI: ESC [ parameters, intermediates, final byte.
  '\\u001b\\[[0-?]*[ -/]*[@-~]',
  // Any other ESC sequence: intermediates then a final byte.
  '\\u001b[ -/]*[0-~]',
  // An ESC that starts nothing.
  '\\u001b',
].join('|'), 'g');

export function stripEscapeSequences(line: string): string {
  return line.replace(ESCAPE_SEQUENCE_RE, '');
}
