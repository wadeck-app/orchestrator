'use strict';

// User regexes run on a job's own log lines inside the daemon: they are validated when configured (length,
// catastrophic shapes) and run under a time budget with a bounded line length.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  compilePattern, createMatcher, matchBudgetMs, MAX_PATTERN_LENGTH, MAX_LINE_LENGTH, COOLDOWN_CALLS, DEFAULT_MATCH_BUDGET_MS, MATCH_BUDGET_ENV,
} = require('../../src/progress/safe-regex');

describe('compilePattern: accepted', () => {
  for (const source of ['(\\d+)/(\\d+)', '(\\d+)%', 'Step (\\d+) of (\\d+)', 'done|finished', '^\\[ok\\]', '(a|b)*c', '(?:foo)+bar', '\\d{1,3}\\.\\d{1,3}']) {
    test(`accepts ${source}`, () => {
      const r = compilePattern(source);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.ok(r.regex instanceof RegExp);
    });
  }
});

describe('compilePattern: refused with an actionable error', () => {
  const cases = {
    'nested quantifier (a+)+': '(a+)+$',
    'nested quantifier (a*)*': '(a*)*b',
    'nested quantifier (\\d+\\s*)+': '(\\d+\\s*)+x',
    'nested bounded quantifier (a{1,5})+': '(a{1,5})+x',
    'identical alternatives under a quantifier (a|a)*': '(a|a)*b',
    'prefix-overlapping alternatives (a|ab)*': '(a|ab)*c',
    'class alternatives overlap (\\d|\\w)*': '(\\d|\\w)*x',
    'dot alternatives (.|x)+': '(.|x)+y',
    'backreference \\1': '(a)\\1',
    'named backreference': '(?<n>a)\\k<n>',
    'too many unbounded quantifiers': '.*a.*b.*c.*d.*e',
    'invalid syntax': '(unclosed',
  };
  for (const [name, source] of Object.entries(cases)) {
    test(name, () => {
      const r = compilePattern(source);
      assert.equal(r.ok, false);
      assert.ok(r.error.length > 20, r.error);
      assert.ok(r.error.includes(source.slice(0, 20)) || /pattern/i.test(r.error), r.error);
    });
  }

  test('longer than the maximum', () => {
    const r = compilePattern('a'.repeat(MAX_PATTERN_LENGTH + 1));
    assert.equal(r.ok, false);
    assert.match(r.error, new RegExp(String(MAX_PATTERN_LENGTH)));
  });

  test('empty and non-string', () => {
    assert.equal(compilePattern('').ok, false);
    assert.equal(compilePattern(42).ok, false);
    assert.match(compilePattern(undefined).error, /string/);
  });

  test('group count is checked on request', () => {
    assert.equal(compilePattern('(\\d+)/(\\d+)', { groups: [1, 2] }).ok, true);
    assert.equal(compilePattern('\\d+', { groups: [1, 2] }).ok, false);
    assert.match(compilePattern('(a)(b)(c)', { groups: [1, 2] }).error, /1 or 2 capture groups/);
  });
});

describe('createMatcher', () => {
  test('returns the captures of each line, null for no match', () => {
    const m = createMatcher(/(\d+)\/(\d+)/);
    const out = m.matchLines(['start', 'file 3/10', 'file 4/10']);
    assert.equal(out.timedOut, false);
    assert.equal(out.matches[0], null);
    assert.deepEqual(out.matches[1], ['3/10', '3', '10']);
    assert.deepEqual(out.matches[2], ['4/10', '4', '10']);
  });

  test('a line longer than the bound is cut, not scanned whole', () => {
    const m = createMatcher(/needle/);
    const long = 'x'.repeat(MAX_LINE_LENGTH + 500) + 'needle';
    assert.equal(m.matchLines([long]).matches[0], null, 'text past the bound is not seen');
    assert.deepEqual(m.matchLines(['x'.repeat(MAX_LINE_LENGTH - 6) + 'needle']).matches[0], ['needle']);
  });

  test('an empty batch is fine', () => {
    assert.deepEqual(createMatcher(/a/).matchLines([]), { matches: [], timedOut: false });
  });

  test('a pathological pattern on a pathological line stops at the budget, within a generous bound', () => {
    // Built directly (compilePattern refuses it): the point is that even a pattern that got through cannot block.
    const m = createMatcher(new RegExp('(a+)+$'), { budgetMs: 100 });
    const started = process.hrtime.bigint();
    const out = m.matchLines(['a'.repeat(60) + '!']);
    const tookMs = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(out.timedOut, true);
    assert.ok(tookMs < 5000, `took ${tookMs} ms`);
  });

  // The budget is a wall-clock watchdog, so a real timeout followed by a "harmless" call that must finish in the budget
  // failed on loaded machines (the harmless call was the one that ran out of time). The timeout of the first call is
  // injected instead; the real watchdog is exercised by the test above.
  test('after a timeout the pattern is not run again for COOLDOWN_CALLS calls, then it is tried again', () => {
    let executions = 0;
    const m = createMatcher(/^(a+)$/, {
      budgetMs: 60_000,
      execute: (real) => {
        executions++;
        if (executions === 1) {
          throw Object.assign(new Error('Script execution timed out after 100ms'), { code: 'ERR_SCRIPT_EXECUTION_TIMEOUT' });
        }
        return real();
      },
    });
    assert.equal(m.matchLines(['aaa']).timedOut, true);
    assert.equal(executions, 1);
    // A harmless line would match at once if it were run: it is not, so a bad pattern costs one budget, not one per poll.
    for (let i = 0; i < COOLDOWN_CALLS; i++) {
      assert.equal(m.matchLines(['aaa']).timedOut, true, `call ${i + 1} of the cooldown`);
    }
    assert.equal(executions, 1, 'the pattern was run during the cooldown');
    const after = m.matchLines(['aaa']);
    assert.equal(after.timedOut, false);
    assert.equal(executions, 2);
    assert.deepEqual(after.matches[0], ['aaa', 'aaa']);
  });

  test('an error that is not the budget running out is not taken for it', () => {
    const m = createMatcher(/a/, { execute: () => { throw new Error('something else'); } });
    assert.throws(() => m.matchLines(['a']), /something else/);
  });
});

describe('the match budget', () => {
  test('is 500 ms unless the environment says otherwise', () => {
    assert.equal(DEFAULT_MATCH_BUDGET_MS, 500);
    assert.equal(matchBudgetMs({}), 500);
    assert.equal(matchBudgetMs({ [MATCH_BUDGET_ENV]: '' }), 500);
  });

  // The suite sets it high in its preload: with every core busy a 500 ms watchdog expired on trivial lines.
  test('can be raised through the environment, for development and tests', () => {
    assert.equal(matchBudgetMs({ [MATCH_BUDGET_ENV]: '60000' }), 60000);
  });

  for (const bad of ['0', '-5', '1.5', 'fast', '10s']) {
    test(`refuses ${JSON.stringify(bad)} and says what to set`, () => {
      assert.throws(() => matchBudgetMs({ [MATCH_BUDGET_ENV]: bad }), new RegExp(`${MATCH_BUDGET_ENV}.*whole number of milliseconds.*${bad.replace('.', '\\.')}`));
    });
  }
});
