'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const { stripAnsi } = require('../src/ansi');
const { ANSI_CASES } = require('./ansi-cases');

describe('stripAnsi', () => {
  for (const [what, input, expected] of ANSI_CASES) {
    test(what, () => {
      assert.equal(stripAnsi(input), expected);
    });
  }

  test('is idempotent', () => {
    for (const [, input] of ANSI_CASES) {
      assert.equal(stripAnsi(stripAnsi(input)), stripAnsi(input));
    }
  });

  test('the dashboard keeps its own helper and both point at each other', () => {
    const cli = fs.readFileSync(path.join(__dirname, '..', 'src', 'ansi.ts'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', '..', 'dsl-lib-orch', 'src', 'strip-ansi.ts'), 'utf8');
    assert.ok(cli.includes('dsl-lib-orch/src/strip-ansi.ts'), 'ansi.ts must name the dashboard copy');
    assert.ok(ui.includes('orchestrator-cli/src/ansi.ts'), 'strip-ansi.ts must name the CLI copy');
  });
});
