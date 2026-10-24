'use strict';

// User regexes run on a job's own log lines inside the daemon: they are validated when configured (length,
// catastrophic shapes) and run under a time budget with a bounded line length.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  compilePattern, createMatcher, MAX_PATTERN_LENGTH, MAX_LINE_LENGTH, COOLDOWN_CALLS,
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

  test('after a timeout the pattern is not run again for COOLDOWN_CALLS calls, then it is tried again', () => {
    const m = createMatcher(new RegExp('(a+)+$'), { budgetMs: 100 });
    assert.equal(m.matchLines(['a'.repeat(60) + '!']).timedOut, true);
    // A harmless line would match at once if it were run: it is not, so a bad pattern costs one budget, not one per poll.
    for (let i = 0; i < COOLDOWN_CALLS; i++) {
      assert.equal(m.matchLines(['aaa']).timedOut, true, `call ${i + 1} of the cooldown`);
    }
    const after = m.matchLines(['aaa']);
    assert.equal(after.timedOut, false);
    assert.deepEqual(after.matches[0], ['aaa', 'aaa']);
  });
});
