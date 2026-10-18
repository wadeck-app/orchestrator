import { describe, it, expect } from 'vitest';
import { describeCron } from './cron-describe.js';

describe('describeCron', () => {
  it.each([
    ['* * * * *',        'Every minute'],
    ['*/5 * * * *',      'Every 5 minutes'],
    ['*/30 * * * *',     'Every 30 minutes'],
    ['0 * * * *',        'Hourly at :00'],
    ['30 * * * *',       'Hourly at :30'],
    ['0 9 * * *',        'Daily at 09:00'],
    ['30 14 * * *',      'Daily at 14:30'],
    ['0 9 * * 1-5',      'Weekdays at 09:00'],
    ['0 9 * * 1',        'Mondays at 09:00'],
    ['0 9 * * 0',        'Sundays at 09:00'],
    ['0 9 1 * *',        'Monthly on the 1st at 09:00'],
    ['0 9 2 * *',        'Monthly on the 2nd at 09:00'],
    ['0 9 3 * *',        'Monthly on the 3rd at 09:00'],
    ['0 9 4 * *',        'Monthly on the 4th at 09:00'],
    ['0 9 21 * *',       'Monthly on the 21st at 09:00'],
    // The teens. Only 1, 2, 3, 4 and 21 were covered, so the suffix rule was never held to the
    // one range where the digit rule does not apply, and the 11th read "11st" in the dashboard.
    // A mutation on the `mod100 >= 12` boundary survived, which is what pointed here.
    ['0 9 11 * *',       'Monthly on the 11th at 09:00'],
    ['0 9 12 * *',       'Monthly on the 12th at 09:00'],
    ['0 9 13 * *',       'Monthly on the 13th at 09:00'],
    ['0 9 22 * *',       'Monthly on the 22nd at 09:00'],
    ['0 9 23 * *',       'Monthly on the 23rd at 09:00'],
    ['0 9 31 * *',       'Monthly on the 31st at 09:00'],
    // Every day name, not just Monday and Sunday: five of the eight keys were unasserted, so a
    // typo or a shifted mapping in DAY_NAMES would have gone through.
    ['0 9 * * 2',        'Tuesdays at 09:00'],
    ['0 9 * * 3',        'Wednesdays at 09:00'],
    ['0 9 * * 4',        'Thursdays at 09:00'],
    ['0 9 * * 5',        'Fridays at 09:00'],
    ['0 9 * * 6',        'Saturdays at 09:00'],
    // 7 is the second spelling of Sunday, and it had no test at all.
    ['0 9 * * 7',        'Sundays at 09:00'],
    // Both ends of the hour field. 23 was never asserted, so narrowing the upper bound to
    // `h < 23` changed nothing that any test could see.
    ['0 0 * * *',        'Daily at 00:00'],
    ['0 23 * * *',       'Daily at 23:00'],
  ])('describes %s as "%s"', (expr, expected) => {
    expect(describeCron(expr)).toBe(expected);
  });

  // The real schedules in this app look like this: a job that runs twice a day lists both
  // hours in one field. Rendering that as "Daily at 10,19:00" was the previous behaviour and
  // is not a time.
  it('reads a list of hours as several daily times', () => {
    expect(describeCron('0 10,19 * * *')).toBe('Daily at 10:00 and 19:00');
  });

  it('reads three or more hours as a comma list ending in and', () => {
    expect(describeCron('30 8,12,18 * * *')).toBe('Daily at 08:30, 12:30 and 18:30');
  });

  it('accepts the optional seconds-or-year sixth field', () => {
    expect(describeCron('0 9 * * * 2026')).toBe('Daily at 09:00');
  });

  it('tolerates surrounding whitespace and repeated spaces', () => {
    expect(describeCron('  0   9  *  *  *  ')).toBe('Daily at 09:00');
  });

  // Returning null rather than guessing is the point: the caller falls back to showing the
  // raw expression, which is honest, where a wrong description would mislead.
  it.each([
    ['0 9 * * 1,3,5'],
    ['0 0 1 1 *'],
    ['15-45 * * * *'],
    ['0 */2 * * *'],
    // Out of range rather than merely non-numeric: the upper bound needs a case on the wrong
    // side of it, or `h <= 23` and `h < 24` are indistinguishable.
    ['0 24 * * *'],
    ['0 99 * * *'],
    ['0 9,24 * * *'],
    // Seven fields. Only the too-few case was covered, so widening the upper bound - or turning
    // the `||` between the two bounds into `&&`, which disables the check entirely - was invisible.
    ['0 9 * * * 2026 extra'],
    // A day-of-month AND a day-of-week together is ambiguous, so it gets no description. Nothing
    // exercised that pair, so relaxing the `&&` to `||` still passed.
    ['0 9 15 * 1'],
    // Days of the month that do not exist. The hour field is range-checked and this one was not,
    // so the description confidently named an impossible schedule.
    ['0 9 0 * *'],
    ['0 9 32 * *'],
    ['0 9 99 * *'],
    ['not a cron'],
    [''],
    ['* * *'],
  ])('returns null for %s rather than guessing', expr => {
    expect(describeCron(expr)).toBeNull();
  });

  it('returns null for a missing schedule', () => {
    expect(describeCron(undefined)).toBeNull();
    expect(describeCron(null)).toBeNull();
  });
});
