/**
 * Turns a cron expression into a sentence, or null when it cannot say something true.
 *
 * The dashboard used to print the expression itself - `Cron: 0 10,19 * * *` - which asks the
 * reader to parse cron. The edit form had a partial version of this inline, covering two
 * shapes and rendering the rest as `Daily at 10,19:00`, which is not a time.
 *
 * Null is a real answer here. A description that quietly guesses at `0 9 * * 1,3,5` is worse
 * than the raw expression, because the raw expression is at least honest about being cron.
 */

const DAY_NAMES: Record<string, string> = {
  '0': 'Sundays', '7': 'Sundays',
  '1': 'Mondays', '2': 'Tuesdays', '3': 'Wednesdays',
  '4': 'Thursdays', '5': 'Fridays', '6': 'Saturdays',
};

/** 1st, 2nd, 3rd, 4th ... 21st. */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${n}th`;
  }
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** "08:30, 12:30 and 18:30" - a list a reader can scan, rather than a raw field. */
function joinTimes(times: string[]): string {
  if (times.length === 1) {
    return times[0]!;
  }
  return `${times.slice(0, -1).join(', ')} and ${times[times.length - 1]}`;
}

function isPlainNumber(field: string): boolean {
  return /^\d+$/.test(field);
}

/** Hours as a list of plain numbers, or null if the field is anything else. */
function hourList(field: string): number[] | null {
  const parts = field.split(',');
  if (!parts.every(isPlainNumber)) {
    return null;
  }
  const hours = parts.map(Number);
  return hours.every(h => h >= 0 && h <= 23) ? hours : null;
}

export function describeCron(expr: string | null | undefined): string | null {
  if (!expr) {
    return null;
  }
  const parts = expr.trim().split(/\s+/);
  // Five fields, plus an optional sixth this app allows and this description ignores.
  if (parts.length < 5 || parts.length > 6) {
    return null;
  }
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];

  if (min === '*' && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'Every minute';
  }

  const everyN = /^\*\/(\d+)$/.exec(min);
  if (everyN && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Every ${everyN[1]} minutes`;
  }

  // Anything below needs a concrete minute; a step or range in the minute field is not
  // something this can phrase.
  if (!isPlainNumber(min)) {
    return null;
  }
  const mm = min.padStart(2, '0');

  if (hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return `Hourly at :${mm}`;
  }

  const hours = hourList(hour);
  if (hours === null || mon !== '*') {
    return null;
  }
  const times = joinTimes(hours.map(h => `${String(h).padStart(2, '0')}:${mm}`));

  if (dom === '*' && dow === '*') {
    return `Daily at ${times}`;
  }
  if (dom === '*' && dow === '1-5') {
    return `Weekdays at ${times}`;
  }
  if (dom === '*' && DAY_NAMES[dow] !== undefined) {
    return `${DAY_NAMES[dow]} at ${times}`;
  }
  // Range-checked like the hour field. Without the bounds this described `0 9 99 * *` as
  // "Monthly on the 99th", naming a day that does not exist - the exact confident guess this
  // module returns null to avoid. A surviving mutant on the hour bounds is what pointed at the
  // asymmetry.
  if (dow === '*' && isPlainNumber(dom)) {
    const day = Number(dom);
    if (day >= 1 && day <= 31) {
      return `Monthly on the ${ordinal(day)} at ${times}`;
    }
  }
  return null;
}
