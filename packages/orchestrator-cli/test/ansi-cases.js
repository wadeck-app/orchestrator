'use strict';

// The sequences both strip helpers must agree on: orchestrator-cli/src/ansi.ts (CLI views, run log files) and
// dsl-lib-orch/src/strip-ansi.ts (dashboard log pane). Each row is [what, input, expected].
// dsl-lib-orch/test/ansi-parity.test.ts keeps a copy of this table: change both together.
const ESC = '\u001b';
const BEL = '\u0007';
// ST, the string terminator: ESC followed by a backslash.
const ST = String.fromCharCode(0x1b, 0x5c);

module.exports.ANSI_CASES = [
  ['plain text is untouched', 'hello world', 'hello world'],
  ['SGR colour', `${ESC}[31mred${ESC}[0m`, 'red'],
  ['256-colour and truecolour SGR', `${ESC}[38;5;208ma${ESC}[38;2;1;2;3mb${ESC}[0m`, 'ab'],
  ['what vite prints around a label', `${ESC}[90m${ESC}[2m(client)${ESC}[22m${ESC}[39m ready`, '(client) ready'],
  ['SGR with no parameter', `${ESC}[mx`, 'x'],
  ['private mode: hide and show cursor', `${ESC}[?25lx${ESC}[?25h`, 'x'],
  ['erase line and cursor column', `${ESC}[2K${ESC}[1Gdone`, 'done'],
  ['cursor up and clear screen', `${ESC}[1A${ESC}[2Jx`, 'x'],
  ['OSC window title ended by BEL', `${ESC}]0;my title${BEL}text`, 'text'],
  ['OSC hyperlink ended by ST', `${ESC}]8;;http://x.test${ST}link${ESC}]8;;${ST}`, 'link'],
  ['OSC cut at the end of the line', `before${ESC}]0;title never ended`, 'before'],
  ['DCS string ended by ST', `${ESC}Pq#0;2;0;0;0${ST}after`, 'after'],
  ['lone ESC sequences: reset, save, restore', `${ESC}cA${ESC}7B${ESC}8C`, 'ABC'],
  ['charset selection with an intermediate byte', `${ESC}(Bx`, 'x'],
  ['a lone ESC at the end of the line', `a${ESC}`, 'a'],
  ['carriage-return progress redraws are left as they are', '10%\r20%\r100%', '10%\r20%\r100%'],
  ['carriage return with an erase code keeps the return', `\r${ESC}[2Kdone`, '\rdone'],
  ['brackets that are not preceded by ESC are text', 'array[0] and [31m', 'array[0] and [31m'],
  ['non-ASCII text next to a sequence', `${ESC}[32mété ✓${ESC}[0m`, 'été ✓'],
];
