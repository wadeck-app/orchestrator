/**
 * Returns the next N firing times for a cron expression (5-field: min hour dom mon dow).
 * Uses a simple minute-by-minute scan over the next 24h.
 */
export function getNextFirings(expression: string, n: number, from: Date = new Date()): Date[] {
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
  // scan minute-by-minute for 24h + 1h buffer
  const cur = new Date(from);
  cur.setSeconds(0, 0);
  cur.setMinutes(cur.getMinutes() + 1); // start from next minute
  const limit = new Date(from.getTime() + 25 * 60 * 60 * 1000);

  while (cur < limit && results.length < n) {
    const min = cur.getMinutes();
    const hour = cur.getHours();
    const dom = cur.getDate();
    const mon = cur.getMonth() + 1; // 1-based
    const dow = cur.getDay(); // 0=Sun

    if (
      matches(min,  minExpr!,  0, 59) &&
      matches(hour, hourExpr!, 0, 23) &&
      matches(dom,  domExpr!,  1, 31) &&
      matches(mon,  monExpr!,  1, 12) &&
      matches(dow,  dowExpr!,  0, 6)
    ) {
      results.push(new Date(cur));
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return results;
}
