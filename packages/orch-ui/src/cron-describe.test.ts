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
