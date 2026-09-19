/**
 * How a once job's schedule reads in `orch list`.
 *
 * An overdue job used to clamp to "in 0s", which says the opposite of what happened: it reads as
 * "about to fire" when the moment has already passed and the job is waiting on a daemon that is not
 * running, or on a catch-up that has not reached it yet. The two states need different words.
 */
export function onceScheduleDisplay(
  scheduledAt: string | undefined,
  delayMs: number | undefined,
  now: number,
): string {
  const base = scheduledAt !== undefined ? new Date(scheduledAt).getTime() : NaN;
  // Said plainly rather than rendered as "in NaNs". A once job with no scheduledAt predates the
  // field's default and cannot be placed in time at all.
  if (Number.isNaN(base) || delayMs === undefined || !Number.isFinite(delayMs)) {
    return 'unscheduled';
  }

  return describeMoment(base + delayMs, now);
}

/**
 * How far off a moment is, in words: "in 3h", "overdue by 5m".
 *
 * Shared with `orch timers`, so a countdown reads the same wherever the CLI prints one. A moment that
 * cannot be parsed says so rather than rendering as "in NaNs".
 */
export function describeMoment(at: string | number, now: number): string {
  const atMs = typeof at === 'number' ? at : new Date(at).getTime();
  if (Number.isNaN(atMs)) return 'unscheduled';
  const remainingMs = atMs - now;
  if (remainingMs >= 0) return `in ${formatSeconds(remainingMs)}`;
  return `overdue by ${formatSeconds(-remainingMs)}`;
}

/**
 * How long ago a moment was: "14d ago".
 *
 * The past-tense counterpart of describeMoment, for things that have already happened -- a spent once
 * job's firing. Running it through describeMoment instead produced "overdue by 14d", which says the
 * job is late when in fact it is finished.
 */
export function describeAgo(at: string | number, now: number): string {
  const atMs = typeof at === 'number' ? at : new Date(at).getTime();
  if (Number.isNaN(atMs)) return 'at an unrecorded time';
  const elapsedMs = now - atMs;
  // A moment in the future here means a clock that moved or a timestamp written by another machine.
  // Saying "in 3h" is at least true; "-3h ago" would not be.
  if (elapsedMs < 0) return describeMoment(atMs, now);
  return `${formatSeconds(elapsedMs)} ago`;
}

/**
 * A duration in the largest unit that keeps it readable.
 *
 * "in 1209600s" is technically the answer and practically unreadable; a fortnight should say so.
 */
function formatSeconds(ms: number): string {
  // The unit changes at twice its own size, not at one: switching at 60 turns 65 seconds into "1m",
  // which throws away the detail a reader is looking at a countdown for. Past 120 the smaller unit
  // has stopped being informative.
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
