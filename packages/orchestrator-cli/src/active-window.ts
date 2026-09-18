import type { Job } from './types.js';

/**
 * Where a job stands relative to its active window.
 *
 * `pending` is the state that makes this worth a type rather than a boolean: a job whose window has
 * not opened yet is enabled and working as configured, which is not the same as disabled and not the
 * same as active. Collapsing the three would leave the dashboard unable to say "starts Monday"
 * instead of "not running".
 */
export type WindowState = 'pending' | 'active' | 'expired';

export interface ActiveWindow {
  from: number | null;
  until: number | null;
}

/** Parses the window, treating an unparseable timestamp as absent rather than as epoch zero. */
export function activeWindowOf(job: Pick<Job, 'activeFrom' | 'activeUntil'>): ActiveWindow {
  return { from: parseMs(job.activeFrom), until: parseMs(job.activeUntil) };
}

function parseMs(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = new Date(iso).getTime();
  // NaN would compare false against every bound, silently making the window unbounded in whichever
  // direction it was meant to close.
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether the job may fire at `nowMs`.
 *
 * Bounds are inclusive at the start and exclusive at the end: a job active "from 09:00 until 10:00"
 * fires at 09:00 and does not at 10:00, so two windows that meet cannot both claim the same instant.
 */
export function windowStateAt(job: Pick<Job, 'activeFrom' | 'activeUntil'>, nowMs: number): WindowState {
  const { from, until } = activeWindowOf(job);
  if (from !== null && nowMs < from) {
    return 'pending';
  }
  if (until !== null && nowMs >= until) {
    return 'expired';
  }
  return 'active';
}

/** Milliseconds until the window opens, or null if it is open or has no start. */
export function msUntilStart(job: Pick<Job, 'activeFrom' | 'activeUntil'>, nowMs: number): number | null {
  const { from } = activeWindowOf(job);
  return from !== null && nowMs < from ? from - nowMs : null;
}

/** Milliseconds until the window closes, or null if it has no end or has already closed. */
export function msUntilEnd(job: Pick<Job, 'activeFrom' | 'activeUntil'>, nowMs: number): number | null {
  const { until } = activeWindowOf(job);
  return until !== null && nowMs < until ? until - nowMs : null;
}

const FOR_UNITS: Record<string, number> = {
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Parses a window LENGTH, as in "active for three weeks".
 *
 * Weeks are the unit this feature is actually asked for, and shared-cli's parseDuration stops at
 * days - so `3w` had to be written `21d`. Minutes and seconds are deliberately absent: a window is a
 * period a job is allowed to run in, and `--active-for 30s` is a mistake rather than a request.
 *
 * Throws rather than returning null, because it parses a value the user typed and the message names
 * what was wrong with it.
 */
export function parseActiveFor(input: string): number {
  const match = /^(\d+(?:\.\d+)?)(h|d|w)$/.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid period: "${input}". Expected a number followed by h, d or w - e.g. 3w, 21d, 48h`);
  }
  const value = parseFloat(match[1]!);
  if (value <= 0) {
    throw new Error(`Invalid period: "${input}". Must be greater than zero`);
  }
  return value * FOR_UNITS[match[2]!]!;
}

/**
 * Validates the window, returning a message or null.
 *
 * A window that ends before it starts can never fire, and accepting it would store a job that looks
 * configured and is silently inert - the same class of defect as a cron expression whose fields are
 * out of range.
 */
export function activeWindowError(job: Pick<Job, 'activeFrom' | 'activeUntil'>): string | null {
  for (const [field, value] of [['activeFrom', job.activeFrom], ['activeUntil', job.activeUntil]] as const) {
    if (value !== undefined && !Number.isFinite(new Date(value).getTime())) {
      return `${field} must be an ISO timestamp (got: ${JSON.stringify(value)})`;
    }
  }
  const { from, until } = activeWindowOf(job);
  if (from !== null && until !== null && until <= from) {
    return `activeUntil must be after activeFrom (${job.activeFrom} -> ${job.activeUntil} never fires)`;
  }
  return null;
}
