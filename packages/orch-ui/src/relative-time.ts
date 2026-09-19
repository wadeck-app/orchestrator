/**
 * Future- and past-facing relative time, in the same words the CLI uses.
 *
 * orch-ui had two relative-time implementations and seven duration formatters, none of them shared
 * and only one facing the future -- a private `relTime` inside ScheduleTimeline. The job card needs
 * future wording, and `orchestrator-cli/src/once-schedule.ts` had already settled on "in 3h" /
 * "overdue by 5m", so this is the orch-ui side of the same phrasing: a countdown reads the same in
 * the terminal and in the dashboard.
 *
 * It deliberately does not import the CLI's version. orch-ui has no dependency on orchestrator-cli
 * (see the note at the top of types.ts, which duplicates the domain types for the same reason), so
 * the wording is duplicated on purpose and pinned by relative-time.test.ts on this side and
 * once-schedule.test.js on the other.
 */

/** A moment that may be an ISO string, epoch millis, or absent. */
export type MomentLike = string | number | undefined | null;

function toMs(at: MomentLike): number | null {
  if (at === undefined || at === null) {
    return null;
  }
  const ms = typeof at === 'number' ? at : new Date(at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * A duration in the largest unit that keeps it readable: "65s", "2m", "47h", "14d".
 *
 * The unit changes at twice its own size, not at one. Switching at 60 turns 65 seconds into "1m",
 * which throws away the detail someone staring at a countdown is there for.
 */
export function formatApproxDuration(ms: number): string {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 120) {
    return `${s}s`;
  }
  const m = Math.round(s / 60);
  if (m < 120) {
    return `${m}m`;
  }
  const h = Math.round(m / 60);
  if (h < 48) {
    return `${h}h`;
  }
  return `${Math.round(h / 24)}d`;
}

/**
 * Time elapsed since a moment, as a live clock: "7s", "1m 5s", "2h 13m".
 *
 * Deliberately not `formatApproxDuration`. That one drops to a single unit and only changes unit at
 * twice its size, which is right for a countdown read at a glance and wrong for a running job: the
 * reader is watching to see it move, and "1m" sitting still for a minute looks like a stalled UI.
 *
 * `now` is a parameter rather than a `Date.now()` call inside, matching describeMoment/describeAgo --
 * the three callers already re-render on their own tick, and a hidden clock read cannot be tested.
 */
export function formatElapsed(startedAt: MomentLike, now: number): string {
  const startedMs = toMs(startedAt);
  if (startedMs === null) {
    return '-';
  }
  // A negative elapsed means a clock skew or a timestamp from another machine. 0s is at least not a
  // count that runs backwards.
  const s = Math.max(0, Math.floor((now - startedMs) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${s % 60}s`;
  }
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * How far off a moment is: "in 3h", "overdue by 5m".
 *
 * An overdue moment says so rather than clamping to "in 0s", which read as "about to fire" for a job
 * whose moment had already passed -- the state that actually means the daemon was down when it was due.
 */
export function describeMoment(at: MomentLike, now: number): string {
  const atMs = toMs(at);
  if (atMs === null) {
    return 'unscheduled';
  }
  const remainingMs = atMs - now;
  return remainingMs >= 0
    ? `in ${formatApproxDuration(remainingMs)}`
    : `overdue by ${formatApproxDuration(-remainingMs)}`;
}

/**
 * How long ago a moment was: "14d ago".
 *
 * For things that have already happened -- a spent once job's firing. Running those through
 * describeMoment produced "overdue by 14d", which says the job is late when it is in fact finished.
 */
export function describeAgo(at: MomentLike, now: number): string {
  const atMs = toMs(at);
  if (atMs === null) {
    return 'at an unrecorded time';
  }
  // A moment in the future here means a clock that moved or a timestamp from another machine. Saying
  // "in 3h" is at least true; "-3h ago" would not be.
  return atMs > now ? describeMoment(atMs, now) : `${formatApproxDuration(now - atMs)} ago`;
}
