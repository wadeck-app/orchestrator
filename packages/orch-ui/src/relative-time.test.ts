import { describe, it, expect } from 'vitest';
import { describeMoment, describeAgo, formatApproxDuration, formatElapsed } from './relative-time.js';

/*
 * orch-ui had seven duration formatters and two relative-time implementations, none shared, and none
 * facing the future except a private one inside ScheduleTimeline. The job card needs future-facing
 * wording ("in 3h", "Starts in 3 days") and the CLI already settled on that phrasing in
 * orchestrator-cli/src/once-schedule.ts -- this module is the orch-ui side of the same words, so a
 * countdown reads the same in the terminal and in the dashboard.
 *
 * It cannot import the CLI's version: orch-ui does not depend on orchestrator-cli, deliberately (see
 * the note at the top of types.ts). The wording is therefore duplicated on purpose and these tests
 * pin it, so the two cannot drift silently.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatApproxDuration', () => {
  // The unit changes at twice its own size, not at one: switching at 60 turns 65 seconds into "1m",
  // which throws away the detail someone reading a countdown is looking for.
  it('keeps seconds until two minutes', () => {
    expect(formatApproxDuration(65 * SECOND)).toBe('65s');
    expect(formatApproxDuration(119 * SECOND)).toBe('119s');
  });

  it('switches to minutes at two minutes, and to hours at two hours', () => {
    expect(formatApproxDuration(120 * SECOND)).toBe('2m');
    expect(formatApproxDuration(119 * MINUTE)).toBe('119m');
    expect(formatApproxDuration(120 * MINUTE)).toBe('2h');
  });

  it('switches to days at two days', () => {
    expect(formatApproxDuration(47 * HOUR)).toBe('47h');
    expect(formatApproxDuration(48 * HOUR)).toBe('2d');
    expect(formatApproxDuration(14 * DAY)).toBe('14d');
  });

  it('zero is zero seconds, not empty', () => {
    expect(formatApproxDuration(0)).toBe('0s');
  });
});

describe('describeMoment', () => {
  it('says how far ahead a future moment is', () => {
    expect(describeMoment(NOW + 3 * HOUR, NOW)).toBe('in 3h');
  });

  // Clamping to "in 0s" read as "about to fire" for a job whose moment had already passed -- the
  // state that actually means the daemon was down when it was due.
  it('says a past moment is overdue rather than clamping to zero', () => {
    expect(describeMoment(NOW - 5 * MINUTE, NOW)).toBe('overdue by 5m');
  });

  it('accepts an ISO string as well as a number', () => {
    expect(describeMoment('2026-09-19T15:00:00.000Z', NOW)).toBe('in 3h');
  });

  it('an unparseable moment says so rather than rendering as "in NaNs"', () => {
    expect(describeMoment('not a date', NOW)).toBe('unscheduled');
    expect(describeMoment(undefined, NOW)).toBe('unscheduled');
  });
});

describe('describeAgo', () => {
  it('says how long ago a past moment was', () => {
    expect(describeAgo(NOW - 14 * DAY, NOW)).toBe('14d ago');
  });

  it('a moment in the future falls back to future wording rather than a negative age', () => {
    expect(describeAgo(NOW + 3 * HOUR, NOW)).toBe('in 3h');
  });

  it('an unparseable moment says so', () => {
    expect(describeAgo(undefined, NOW)).toBe('at an unrecorded time');
  });
});

/*
 * ScheduleTimeline's wording, folded in from its own private relTime. Pinned because the default
 * one-unit form would silently coarsen the schedule page: "in 3h" for a firing due at 3h20.
 */
describe('describeMoment precise', () => {
  it('keeps the minutes past an hour', () => {
    expect(describeMoment(NOW + 3 * HOUR + 20 * MINUTE, NOW, { precise: true })).toBe('in 3h 20m');
  });

  // "in 3h 0m" reads as a machine talking.
  it('drops a zero remainder', () => {
    expect(describeMoment(NOW + 3 * HOUR, NOW, { precise: true })).toBe('in 3h');
  });

  it('is minutes only below an hour, and seconds only below a minute', () => {
    expect(describeMoment(NOW + 9 * MINUTE, NOW, { precise: true })).toBe('in 9m');
    expect(describeMoment(NOW + 47 * SECOND, NOW, { precise: true })).toBe('in 47s');
  });

  // At the day range the reader is placing the firing on a calendar, not timing it.
  it('is whole days beyond a day', () => {
    expect(describeMoment(NOW + 2 * DAY + 5 * HOUR, NOW, { precise: true })).toBe('in 2d');
  });

  /*
   * The old relTime said "now" for anything already past, which hid a firing the daemon missed behind
   * the same word it used for one about to happen.
   */
  it('says an overdue firing is overdue, not "now"', () => {
    expect(describeMoment(NOW - 5 * MINUTE, NOW, { precise: true })).toBe('overdue by 5m');
  });

  it('the default is still the one-unit form', () => {
    expect(describeMoment(NOW + 3 * HOUR + 20 * MINUTE, NOW)).toBe('in 3h');
  });
});

/*
 * The live clock on a running job. Three components had byte-identical private copies of this; the
 * wording is pinned here so replacing them cannot have changed what the dashboard shows.
 */
describe('formatElapsed', () => {
  it('counts seconds under a minute', () => {
    expect(formatElapsed(NOW - 7 * SECOND, NOW)).toBe('7s');
    expect(formatElapsed(NOW - 59 * SECOND, NOW)).toBe('59s');
  });

  // Two units, unlike formatApproxDuration: the reader is watching to see it move, and a bare "1m"
  // sitting still for a minute looks like a stalled UI.
  it('keeps the seconds once it passes a minute', () => {
    expect(formatElapsed(NOW - 65 * SECOND, NOW)).toBe('1m 5s');
    expect(formatElapsed(NOW - 59 * MINUTE - 59 * SECOND, NOW)).toBe('59m 59s');
  });

  it('drops to hours and minutes past an hour', () => {
    expect(formatElapsed(NOW - 2 * HOUR - 13 * MINUTE, NOW)).toBe('2h 13m');
    expect(formatElapsed(NOW - 26 * HOUR, NOW)).toBe('26h 0m');
  });

  it('accepts an ISO string as well as epoch millis', () => {
    expect(formatElapsed('2026-09-19T11:58:55.000Z', NOW)).toBe('1m 5s');
  });

  // A clock skew or a timestamp from another machine. 0s is at least not a count running backwards.
  it('clamps a future moment to zero rather than going negative', () => {
    expect(formatElapsed(NOW + 5 * MINUTE, NOW)).toBe('0s');
  });

  it('an unparseable moment is a dash, not NaN', () => {
    expect(formatElapsed(undefined, NOW)).toBe('-');
    expect(formatElapsed('not a date', NOW)).toBe('-');
  });
});
