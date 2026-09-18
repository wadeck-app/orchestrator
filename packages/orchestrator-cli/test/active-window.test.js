'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  windowStateAt, msUntilStart, msUntilEnd, activeWindowError, activeWindowOf, parseActiveFor,
} = require('../src/active-window');

/*
 * A cron job can be given a window: "active for three weeks", or a period that has not started yet.
 *
 * At the end the job is DISABLED, not deleted - its definition, history and logs stay, and turning it
 * back on is a decision rather than a recovery.
 */

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function win(from, until) {
  return {
    ...(from === undefined ? {} : { activeFrom: new Date(from).toISOString() }),
    ...(until === undefined ? {} : { activeUntil: new Date(until).toISOString() }),
  };
}

describe('a job with no window is always active', () => {
  test('no bounds at all', () => {
    assert.equal(windowStateAt({}, T0), 'active');
  });

  test('reports no start or end to wait for', () => {
    assert.equal(msUntilStart({}, T0), null);
    assert.equal(msUntilEnd({}, T0), null);
  });
});

/*
 * The state that earns its own name. A job whose window has not opened is enabled and working as
 * configured - not disabled, and not active. Collapsing the three would leave the UI unable to say
 * "starts Monday" rather than "not running".
 */
describe('a window that starts in the future', () => {
  test('is pending before it opens', () => {
    assert.equal(windowStateAt(win(T0 + DAY), T0), 'pending');
  });

  test('becomes active exactly at the start', () => {
    assert.equal(windowStateAt(win(T0), T0), 'active', 'the start bound is inclusive');
  });

  test('reports how long until it opens', () => {
    assert.equal(msUntilStart(win(T0 + 3 * DAY), T0), 3 * DAY);
  });

  test('reports nothing to wait for once open', () => {
    assert.equal(msUntilStart(win(T0 - DAY), T0), null);
  });
});

describe('a window that ends', () => {
  test('is active before the end', () => {
    assert.equal(windowStateAt(win(undefined, T0 + HOUR), T0), 'active');
  });

  // Exclusive, so two windows that meet cannot both claim the same instant.
  test('is expired exactly at the end', () => {
    assert.equal(windowStateAt(win(undefined, T0), T0), 'expired', 'the end bound is exclusive');
  });

  test('reports how long until it closes', () => {
    assert.equal(msUntilEnd(win(undefined, T0 + 2 * HOUR), T0), 2 * HOUR);
  });

  test('reports nothing once closed', () => {
    assert.equal(msUntilEnd(win(undefined, T0 - HOUR), T0), null);
  });
});

describe('a bounded window, which is what "active for three weeks" means', () => {
  const threeWeeks = win(T0, T0 + 21 * DAY);

  test('pending before, active inside, expired after', () => {
    assert.equal(windowStateAt(threeWeeks, T0 - 1), 'pending');
    assert.equal(windowStateAt(threeWeeks, T0), 'active');
    assert.equal(windowStateAt(threeWeeks, T0 + 10 * DAY), 'active');
    assert.equal(windowStateAt(threeWeeks, T0 + 21 * DAY), 'expired');
  });

  test('a future three-week window is pending, not active', () => {
    const later = win(T0 + 7 * DAY, T0 + 28 * DAY);
    assert.equal(windowStateAt(later, T0), 'pending');
    assert.equal(msUntilStart(later, T0), 7 * DAY);
  });
});

/*
 * An unparseable timestamp must not be read as epoch zero, and must not silently leave the window
 * unbounded in the direction it was meant to close.
 */
describe('a malformed window is rejected rather than misread', () => {
  test('parses an unparseable bound as absent', () => {
    assert.deepEqual(activeWindowOf({ activeFrom: 'not a date' }), { from: null, until: null });
  });

  test('names an unparseable bound', () => {
    assert.match(activeWindowError({ activeFrom: 'soon' }), /activeFrom must be an ISO timestamp/);
    assert.match(activeWindowError({ activeUntil: 'later' }), /activeUntil must be an ISO timestamp/);
  });

  // A window that closes before it opens can never fire: accepting it would store a job that looks
  // configured and is silently inert.
  test('refuses a window that ends before it starts', () => {
    const err = activeWindowError(win(T0 + DAY, T0));
    assert.match(err, /activeUntil must be after activeFrom/);
    assert.match(err, /never fires/);
  });

  test('refuses a zero-length window', () => {
    assert.match(activeWindowError(win(T0, T0)), /must be after/);
  });

  test('accepts a valid window, and no window', () => {
    assert.equal(activeWindowError(win(T0, T0 + DAY)), null);
    assert.equal(activeWindowError({}), null);
    assert.equal(activeWindowError(win(T0)), null);
    assert.equal(activeWindowError(win(undefined, T0)), null);
  });
});

/*
 * Weeks are the unit this feature was asked in - "actif pendant 3 semaines" - and shared-cli's
 * parseDuration stops at days, so three weeks had to be written 21d.
 */
describe('parseActiveFor', () => {
  test('parses the unit the feature is asked in', () => {
    assert.equal(parseActiveFor('3w'), 21 * DAY);
  });

  test('parses days and hours too', () => {
    assert.equal(parseActiveFor('21d'), 21 * DAY);
    assert.equal(parseActiveFor('48h'), 48 * HOUR);
  });

  test('accepts a fraction', () => {
    assert.equal(parseActiveFor('1.5d'), 1.5 * DAY);
  });

  test('tolerates surrounding whitespace', () => {
    assert.equal(parseActiveFor('  3w  '), 21 * DAY);
  });

  // A window is a period a job may run in, so sub-hour units are a mistake rather than a request.
  test('refuses minutes and seconds', () => {
    assert.throws(() => parseActiveFor('30m'), /Expected a number followed by h, d or w/);
    assert.throws(() => parseActiveFor('30s'), /h, d or w/);
  });

  test('refuses zero and negatives', () => {
    assert.throws(() => parseActiveFor('0d'), /greater than zero/);
    assert.throws(() => parseActiveFor('-3w'), /Expected a number/);
  });

  test('names what was wrong with the input', () => {
    assert.throws(() => parseActiveFor('three weeks'), /Invalid period: "three weeks"/);
  });
});
