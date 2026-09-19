import type { Job } from './types.js';

/**
 * Where a job stands relative to its active window, for the dashboard.
 *
 * Mirrors `orchestrator-cli/src/active-window.ts`. orch-ui has no dependency on orchestrator-cli --
 * deliberately, the same reason the domain types are duplicated at the top of types.ts -- so the logic
 * is restated here and pinned by active-window.test.ts on this side and by scheduler-active-window
 * plus active-window tests on the other.
 *
 * The semantics must match exactly, because the daemon decides when a job fires and the card only
 * describes that decision. A card saying "active" where the daemon says "expired" would be advertising
 * a job the daemon has already disabled.
 *
 * `pending` is why this is a union rather than a boolean: a job whose window has not opened yet is
 * enabled and working as configured, which is neither disabled nor active. Collapsing the three leaves
 * the card unable to say "starts Monday" instead of "not running".
 */
export type WindowState = 'pending' | 'active' | 'expired';

type WindowFields = Pick<Job, 'activeFrom' | 'activeUntil'>;

function parseMs(iso: string | undefined): number | null {
  if (!iso) {
    return null;
  }
  const ms = new Date(iso).getTime();
  // NaN compares false against every bound, which would silently make the window unbounded in
  // whichever direction it was meant to close.
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whether the job may fire at `nowMs`.
 *
 * Inclusive at the start and exclusive at the end: a job active "from 09:00 until 10:00" fires at
 * 09:00 and does not at 10:00, so two windows that meet cannot both claim the same instant.
 */
export function windowStateAt(job: WindowFields, nowMs: number): WindowState {
  const from = parseMs(job.activeFrom);
  const until = parseMs(job.activeUntil);
  if (from !== null && nowMs < from) {
    return 'pending';
  }
  if (until !== null && nowMs >= until) {
    return 'expired';
  }
  return 'active';
}

/** Milliseconds until the window opens, or null if it is already open or has no start. */
export function msUntilStart(job: WindowFields, nowMs: number): number | null {
  const from = parseMs(job.activeFrom);
  return from !== null && nowMs < from ? from - nowMs : null;
}

/** Milliseconds until the window closes, or null if it has no end or has already closed. */
export function msUntilEnd(job: WindowFields, nowMs: number): number | null {
  const until = parseMs(job.activeUntil);
  return until !== null && nowMs < until ? until - nowMs : null;
}
