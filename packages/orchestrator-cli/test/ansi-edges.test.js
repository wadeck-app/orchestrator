'use strict';

// Edges of src/ansi.ts that are pinned for the JS helper only. They are NOT in test/ansi-cases.js on purpose: that
// table is shared with the Go supervisor (supervisor-go/ansi.go) and the dashboard copy (dsl-lib-orch/src/strip-ansi.ts),
// which have not been checked against these inputs. Once they have, the rows below can move to the shared table.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { stripAnsi } = require('../src/ansi');

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

describe('stripAnsi: more sequences', () => {
  for (const [what, input, expected] of [
    ['APC string ended by ST', `a${ESC}_Gi=1;payload${ST}b`, 'ab'],
    ['PM string ended by BEL', `a${ESC}^private message${BEL}b`, 'ab'],
    ['SOS string ended by ST', `a${ESC}Xstart of string${ST}b`, 'ab'],
    ['APC cut at the end of the line', `a${ESC}_never ended`, 'a'],
    ['CSI with an intermediate byte (cursor style)', `a${ESC}[2 qb`, 'ab'],
    ['CSI with several parameters and an intermediate', `a${ESC}[1;2;3$ub`, 'ab'],
    ['adjacent sequences leave nothing between them', `${ESC}[31m${ESC}[1m${ESC}[0m${ESC}]0;t${BEL}${ESC}[2Kx`, 'x'],
    ['an OSC, then text, then another OSC', `${ESC}]0;one${BEL}text${ESC}]0;two${BEL}`, 'text'],
    ['a sequence between two multibyte characters', `é${ESC}[0m🎉`, 'é🎉'],
  ]) {
    test(what, () => {
      assert.equal(stripAnsi(input), expected);
    });
  }

  test('the 8-bit CSI (U+009B) is not an escape sequence for this helper: it is kept, with its parameters', () => {
    // Pinned as it is today: only 7-bit ESC introducers are recognised (UTF-8 output never carries the 8-bit form).
    assert.equal(stripAnsi('\u009b31mred'), '\u009b31mred');
  });

  test('a long unterminated OSC is removed whole', () => {
    const body = 'x'.repeat(200_000);

    assert.equal(stripAnsi(`start${ESC}]0;${body}`), 'start');
  });

  test('a string cut by another sequence (no BEL, no ST) loses its ESC and keeps the colour code out: no raw ESC survives', () => {
    // The title text of the aborted OSC stays as text today (see the QUESTIONS of the report); what must hold is that
    // no escape byte reaches a file, however many of them are chained.
    const out = stripAnsi(`${ESC}]0;title${ESC}[31mred`);
    assert.equal(out.includes(ESC), false);
    assert.ok(out.endsWith('red'));

    const chained = stripAnsi(`${ESC}]0;a`.repeat(20_000) + 'end');
    assert.equal(chained.includes(ESC), false);
    // The last string runs to the end of the line, so "end" belongs to it.
    assert.equal(chained.endsWith('end'), false);
  });

  test('a long run of digits after ESC[ with no final byte does not swallow the text after it', () => {
    const digits = '1'.repeat(100_000);

    // The CSI never ends; what is left is the parameter digits as text, not the whole rest of the input.
    assert.equal(stripAnsi(`${ESC}[${digits}`), digits);
  });
});
