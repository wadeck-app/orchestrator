import React from 'react';
import { Tooltip } from '@wadeck-app/dsl-ui';
import { describeCron } from '../cron-describe.js';
import { describeMoment, describeAgo, formatApproxDuration } from '../relative-time.js';
import { windowStateAt, msUntilStart, msUntilEnd } from '../active-window.js';
import type { Job } from '../types.js';

export interface NextFireCountdownProps {
  job: Job;
  /**
   * "Now", in epoch millis. Defaults to the real clock; the tests pass a fixed value.
   *
   * A prop rather than a hook because this component renders inside a list that already re-polls every
   * 30s: a per-card interval would mean one timer per card to move a label that changes by the minute.
   */
  nowMs?: number;
}

/**
 * When a job next runs, in words.
 *
 * Three things a reader needs and the card could not say:
 *
 * - A cron job's active window. `activeFrom` may be in the future, which is a third state rather than
 *   a flavour of disabled: the job is enabled and correctly doing nothing until Monday. The card used
 *   to show the same "every day at 03:00" for that job as for one firing tonight.
 * - `activeUntil`, because "why did my job disable itself" otherwise has no answer anywhere in the UI.
 * - A `once` job's moment. This returned the bare word "Once", which only repeated the type badge
 *   beside it while discarding the one fact that matters -- ahead, behind, or already done.
 *
 * @registryCategory atomic
 * @registryTags countdown schedule window
 */
export function NextFireCountdown({ job, nowMs }: NextFireCountdownProps): React.ReactElement {
  const now = nowMs ?? Date.now();

  if (job.type === 'startup') {
    return <span className="text-sm text-muted">On startup</span>;
  }
  if (job.type === 'once') {
    return <span className="text-sm text-muted">{onceWording(job, now)}</span>;
  }

  const schedule = job.schedule ?? null;
  const described = describeCron(schedule);
  const state = windowStateAt(job, now);

  /*
   * An expired window is reported on its own, with no schedule beside it. The daemon disables the job
   * at `activeUntil`, so printing "every day at 03:00" here would advertise firings that will not
   * happen -- the same mistake `orch timers` used to make by calling a finished job un-armed.
   */
  if (state === 'expired') {
    return <span className="text-sm text-muted">Active period ended</span>;
  }

  // The schedule still shows for a pending job: it is what the job will do once the window opens, and
  // hiding it would leave the card unable to say what "starts in 3d" actually starts.
  const scheduleLabel = described !== null && schedule !== null
    ? <Tooltip content={schedule}><span className="text-sm text-muted">{described}</span></Tooltip>
    : <span className="text-sm text-muted">Cron: {schedule ?? '-'}</span>;

  const window = windowWording(job, now, state);
  if (window === null) {
    return scheduleLabel;
  }
  return (
    <span className="flex items-center gap-1.5">
      {scheduleLabel}
      <span className="text-xs text-muted opacity-80">({window})</span>
    </span>
  );
}

/**
 * The window note beside a cron job's schedule, or null when there is nothing to say.
 *
 * A pending window is announced ahead of the end: a job that has not started yet is not about to
 * expire, and mentioning both would be two countdowns for one job.
 */
function windowWording(job: Job, now: number, state: ReturnType<typeof windowStateAt>): string | null {
  if (state === 'pending') {
    const until = msUntilStart(job, now);
    return until === null ? null : `Starts in ${formatApproxDuration(until)}`;
  }
  const remaining = msUntilEnd(job, now);
  return remaining === null ? null : `Expires in ${formatApproxDuration(remaining)}`;
}

/**
 * A `once` job's moment, in the same words the CLI uses (`onceScheduleDisplay`).
 *
 * A spent job says when it fired rather than how late it is: "overdue by 14d" describes a moment the
 * job has already acted on, which reads as late when it is in fact finished.
 */
function onceWording(job: Job, now: number): string {
  if (job.spent === true) {
    return `Fired ${describeAgo(job.spentAt, now)}`;
  }
  // Both are needed to place the job in time at all. A job written before `scheduledAt` existed has
  // no origin to measure `delayMs` from, and saying so beats rendering "in NaNs".
  if (job.scheduledAt === undefined || job.delayMs === undefined) {
    return 'unscheduled';
  }
  const base = new Date(job.scheduledAt).getTime();
  if (!Number.isFinite(base)) {
    return 'unscheduled';
  }
  return describeMoment(base + job.delayMs, now);
}
