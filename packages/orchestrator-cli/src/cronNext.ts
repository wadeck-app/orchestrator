/**
 * Returns the most recent firing time for a cron expression strictly before `before`.
 * Scans backward from `before` up to 48h to find the last match.
 * Returns null if no firing found in that window.
 */
export function getLastFiring(expression: string, before: Date = new Date()): Date | null {
  // Horizon pinned to the 48h it actually looks at. Without it this would inherit the default
  // one-year scan and walk up to half a million minutes to collect firings it then throws away.
  const firings = getNextFirings(
    expression, 1000, new Date(before.getTime() - 48 * 60 * 60 * 1000), 48 * 60 * 60 * 1000,
  );
  const past = firings.filter(d => d < before);
  return past.length > 0 ? past[past.length - 1]! : null;
}

/** One year, the default horizon: long enough for a yearly cron to have a next firing. */
const DEFAULT_HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Returns the next N firing times for a cron expression (5-field: min hour dom mon dow).
 * Uses a minute-by-minute scan, stopping as soon as N are found or the horizon is reached.
 *
 * The horizon used to be 25 hours, which silently truncated every schedule sparser than daily:
 * `get-schedule` asks for 5 firings, and a weekly or yearly job returned an empty list, so
 * `orch schedule` and the dashboard's next-firing column showed nothing at all for them. A daily
 * job returned 1 of the 5 asked. The scan exits at the Nth match, so frequent schedules cost
 * exactly what they did before.
 */
export function getNextFirings(
  expression: string,
  n: number,
  from: Date = new Date(),
  horizonMs: number = DEFAULT_HORIZON_MS,
): Date[] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5) return [];
  const [minExpr, hourExpr, domExpr, monExpr, dowExpr] = parts;

  function matches(val: number, expr: string, min: number, max: number): boolean {
    if (expr === '*') return true;
    for (const part of expr.split(',')) {
      if (part.includes('/')) {
        const [range, step] = part.split('/');
        const stepN = parseInt(step!, 10);
        const start = range === '*' ? min : parseInt(range!, 10);
        for (let v = start; v <= max; v += stepN) if (v === val) return true;
      } else if (part.includes('-')) {
        const [lo, hi] = part.split('-').map(Number);
        if (val >= lo! && val <= hi!) return true;
      } else {
        if (parseInt(part, 10) === val) return true;
      }
    }
    return false;
  }

  const results: Date[] = [];
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1); // start from next minute
  const limit = new Date(from.getTime() + horizonMs);

  while (cur < limit && results.length < n) {
    // Skip whole days and hours that cannot match, instead of testing all 1440 minutes in them.
    // A minute-by-minute walk over the one-year horizon costs about 110ms per expression, and
    // get-schedule calls this once per cron job: twenty sparse jobs took 2.1s of blocked event
    // loop. Stepping over impossible days brings the same answer down to well under a millisecond.
    if (
      !matches(cur.getDate(),      domExpr!, 1, 31) ||
      !matches(cur.getMonth() + 1, monExpr!, 1, 12) ||
      !matches(cur.getDay(),       dowExpr!, 0, 6)
    ) {
      cur.setDate(cur.getDate() + 1);
      cur.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matches(cur.getHours(), hourExpr!, 0, 23)) {
      cur.setHours(cur.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (matches(cur.getMinutes(), minExpr!, 0, 59)) {
      results.push(new Date(cur));
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return results;
}
