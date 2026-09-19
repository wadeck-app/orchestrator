'use strict';

// cronNext had no tests, in a daemon whose whole purpose is running cron jobs. Added with the fix
// for a 25h scan horizon that returned an empty list for every schedule sparser than daily.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { getNextFirings, getLastFiring } = require('../src/cronNext');

// 2026-01-01 is a Thursday, so a "Monday" expression cannot match on the starting day.
const FROM = new Date('2026-01-01T00:00:00.000Z');

/**
 * Reference implementation: tests every single minute, with no day or hour skipping.
 *
 * The optimisation being guarded steps over days and hours that cannot match, which is where an
 * off-by-one silently drops firings. Comparing against an exhaustive walk is the only way to show
 * the two agree, rather than asserting the answers I happened to expect.
 */
function bruteForce(expression, n, from, horizonMs) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) {
    return [];
  }
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;
  const matches = (val, expr, min, max) => {
    if (expr === '*') {
      return true;
    }
    for (const part of expr.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const stepN = parseInt(step, 10);
        const start = range === '*' ? min : parseInt(range, 10);
        for (let v = start; v <= max; v += stepN) if (v === val) {
          return true;
        }
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        if (val >= lo && val <= hi) {
          return true;
        }
      } else if (parseInt(part, 10) === val) {
        return true;
      }
    }
    return false;
  };
  const out = [];
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1);
  const limit = new Date(from.getTime() + horizonMs);
  while (cur < limit && out.length < n) {
    if (
      matches(cur.getMinutes(), minExpr, 0, 59)
      && matches(cur.getHours(), hourExpr, 0, 23)
      && matches(cur.getDate(), domExpr, 1, 31)
      && matches(cur.getMonth() + 1, monExpr, 1, 12)
      && matches(cur.getDay(), dowExpr, 0, 6)
    ) {
      out.push(new Date(cur));
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return out;
}

describe('getNextFirings horizon', () => {
  // The regression: get-schedule asks for 5, and anything sparser than daily returned nothing.
  const cases = [
    ['*/30 * * * *', 'every 30 minutes'],
    ['0 * * * *', 'hourly'],
    ['0 9 * * *', 'daily'],
    ['0 9 * * 1', 'weekly on Monday'],
    ['0 9 1 * *', 'monthly on the 1st'],
  ];
  for (const [expr, label] of cases) {
    test(`${label} returns all 5 firings asked for`, () => {
      const got = getNextFirings(expr, 5, FROM);
      assert.equal(got.length, 5, `"${expr}" returned ${got.length} of 5`);
    });
  }

  test('a yearly schedule returns its single firing within the horizon', () => {
    const got = getNextFirings('0 9 1 7 *', 5, FROM);
    assert.equal(got.length, 1, 'expected exactly one 1 July inside a one-year horizon');
    assert.equal(got[0].getMonth() + 1, 7);
    assert.equal(got[0].getDate(), 1);
  });

  test('weekly lands on a Monday, not merely on some day', () => {
    const got = getNextFirings('0 9 * * 1', 3, FROM);
    for (const d of got) assert.equal(d.getDay(), 1, `${d.toISOString()} is not a Monday`);
  });

  test('firings are strictly increasing and after the starting point', () => {
    const got = getNextFirings('*/17 * * * *', 20, FROM);
    assert.equal(got.length, 20);
    assert.ok(got[0].getTime() > FROM.getTime(), 'first firing is not after `from`');
    for (let i = 1; i < got.length; i++) {
      assert.ok(got[i].getTime() > got[i - 1].getTime(),
        `firing ${i} does not advance: the schedule would stall or repeat`);
    }
  });
});

describe('day and hour skipping matches an exhaustive scan', () => {
  const exprs = [
    '*/30 * * * *',
    '0 * * * *',
    '0 9 * * *',
    '0 9 * * 1',
    '0 9 1 * *',
    '30 6,18 * * *',
    '0 0 1-7 * *',
    '15 9 * * 1-5',
    '0 9 1 7 *',
  ];
  const horizonMs = 366 * 24 * 60 * 60 * 1000;
  for (const expr of exprs) {
    test(`"${expr}" agrees with the brute-force walk`, () => {
      const fast = getNextFirings(expr, 5, FROM).map(d => d.toISOString());
      const slow = bruteForce(expr, 5, FROM, horizonMs).map(d => d.toISOString());
      assert.deepEqual(fast, slow, 'skipping days or hours changed the answer');
    });
  }
});

describe('getNextFirings input handling', () => {
  test('an expression with fewer than 5 fields yields nothing rather than throwing', () => {
    assert.deepEqual(getNextFirings('0 9 * *', 5, FROM), []);
  });

  test('n is respected exactly', () => {
    assert.equal(getNextFirings('* * * * *', 7, FROM).length, 7);
  });

  test('an explicit horizon still truncates', () => {
    // getLastFiring depends on this: it passes 48h and would otherwise scan a year.
    const got = getNextFirings('0 9 * * *', 5, FROM, 48 * 60 * 60 * 1000);
    assert.equal(got.length, 2, 'a 48h horizon should hold exactly two daily firings');
  });
});

describe('getLastFiring', () => {
  test('returns the most recent firing strictly before the reference', () => {
    const last = getLastFiring('0 9 * * *', FROM);
    assert.ok(last, 'expected a firing in the previous 48h');
    assert.ok(last.getTime() < FROM.getTime(), 'returned a firing at or after the reference');
    assert.equal(last.getHours(), 9);
  });

  test('returns null when nothing fired in the 48h window', () => {
    // A yearly schedule cannot have fired in the two days before 1 January.
    assert.equal(getLastFiring('0 9 1 7 *', FROM), null);
  });
});

// Guards the cost, not just the result: the naive walk took 110ms per sparse expression, and
// get-schedule runs one per cron job, so twenty of them blocked the daemon for over two seconds.
describe('sparse schedules stay cheap', () => {
  test('twenty yearly lookups stay well under a second', () => {
    const started = Date.now();
    for (let i = 0; i < 20; i++) getNextFirings('0 9 1 7 *', 5, FROM);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 500, `twenty sparse lookups took ${elapsed}ms; the day-skip has regressed`);
  });
});
