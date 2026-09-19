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

  const remainingMs = base + delayMs - now;
  if (remainingMs >= 0) return `in ${formatSeconds(remainingMs)}`;
  return `overdue by ${formatSeconds(-remainingMs)}`;
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
