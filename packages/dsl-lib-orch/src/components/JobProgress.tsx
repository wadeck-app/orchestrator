import React, { useEffect, useRef, useState } from 'react';
import { Progress, Tooltip } from '@wadeck-app/dsl-ui';
import type { ProgressEstimate } from '../types.js';

export interface JobProgressProps {
  /** The `progress` of GET /api/jobs/{id}. Nothing is rendered for null/absent: the job has no open run, or the first poll has not answered yet. */
  progress?: ProgressEstimate | null;
  /** "Now" in epoch millis. Defaults to this machine's clock moved onto the daemon's; the tests pass a fixed value. */
  nowMs?: number;
  /**
   * Take the whole width of the parent: the bar and the percentage keep their size, the end text takes what is left and is
   * cut with an ellipsis (its full text is the title) only if it cannot fit. For a row of its own, such as the job card's.
   */
  fill?: boolean;
}

/**
 * Makes the track of a dsl-ui Progress inside the element visible. dsl-ui paints it bg-muted-bg, which is invisible on light
 * surfaces and has no prop to change. Radix gives the track role=progressbar; the selector outranks the single bg-muted-bg class.
 * The literal sits in this file so Tailwind finds it; every bar of this package takes it from here.
 */
export const PROGRESS_TRACK_CLS = '[&_[role=progressbar]]:bg-progress-track';

const TWO_DIGITS = (n: number): string => String(n).padStart(2, '0');

/**
 * "in <1 min", "in 6 min", "in 2 h 05 min" up to six hours; then whole hours ("in 14 h", rounded up like the minutes) and, from a day,
 * days and hours ("in 1 d 2 h"). "any moment now" once the end time has passed (the next poll will say more).
 */
export function formatRemaining(ms: number): string {
  if (ms <= 0) {
    return 'any moment now';
  }
  if (ms < 60_000) {
    return 'in <1 min';
  }
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  if (minutes < 360) {
    return `in ${Math.floor(minutes / 60)} h ${TWO_DIGITS(minutes % 60)} min`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `in ${hours} h`;
  }
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `in ${days} d` : `in ${days} d ${hours % 24} h`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Local end time: "HH:MM" today, "tomorrow HH:MM", the weekday ("Thu 03:10") up to six days ahead, "MM-DD HH:MM" beyond
 * (and for an end before today).
 */
export function formatEndTime(etaAt: string, nowMs: number): string {
  const eta = new Date(etaAt);
  const hhmm = `${TWO_DIGITS(eta.getHours())}:${TWO_DIGITS(eta.getMinutes())}`;
  // Rounded: a day is 23 or 25 hours across a clock change.
  const days = Math.round((startOfDay(eta) - startOfDay(new Date(nowMs))) / 86_400_000);
  if (days === 0) {
    return hhmm;
  }
  if (days === 1) {
    return `tomorrow ${hhmm}`;
  }
  if (days >= 2 && days <= 6) {
    return `${WEEKDAYS[eta.getDay()]!} ${hhmm}`;
  }
  return `${TWO_DIGITS(eta.getMonth() + 1)}-${TWO_DIGITS(eta.getDate())} ${hhmm}`;
}

/** Same cap as the daemon's: a run that is still open never reads 100 %. */
const CAP = 0.99;

/**
 * "Now" for an estimate, in epoch millis, on the daemon's clock, and a re-render every second while the estimate has an end
 * time to count down to. The offset between the two clocks is fixed when an estimate first arrives (a new `serverNow`).
 * `nowMs` replaces the clock (and the tick) for the tests.
 *
 * Shared by JobProgress and the cells of the list view, so a card and a table row never disagree on the countdown.
 */
export function useProgressNow(progress: ProgressEstimate | null | undefined, nowMs?: number): number {
  const [, setTick] = useState(0);
  const skew = useRef<{ serverNow: string; ms: number } | null>(null);

  const ticks = progress != null && progress.etaAt !== null && nowMs === undefined;
  useEffect(() => {
    if (!ticks) {
      return;
    }
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [ticks]);

  if (progress != null && (skew.current === null || skew.current.serverNow !== progress.serverNow)) {
    skew.current = { serverNow: progress.serverNow, ms: Date.parse(progress.serverNow) - Date.now() };
  }
  return nowMs ?? Date.now() + (skew.current === null || Number.isNaN(skew.current.ms) ? 0 : skew.current.ms);
}

/** What an estimate says at a given "now": the shared reading behind the card's row and the list view's two cells. */
export interface ProgressView {
  /** `none`: no percentage (the reason says why). `overdue`: a percentage but no end time. */
  state: 'none' | 'estimate' | 'overdue';
  /** Percentage to draw, 0-99; only meaningful unless `state` is `none`. */
  pct: number;
  /** "ends ~14:32 (in 6 min)" for an estimate, the reason otherwise. */
  detail: string;
  low: boolean;
  /** Strategy-qualified reason, for a tooltip. */
  tooltip: string;
}

/**
 * Between two polls the percentage is moved toward the cap along the line to the end time, so a 30 s poll does not make the
 * bar look frozen. The estimate itself is only ever replaced by the next poll.
 */
export function viewProgress(progress: ProgressEstimate, now: number): ProgressView {
  const tooltip = `${progress.reason}${progress.strategyId ? ` [strategy: ${progress.strategyId}]` : ''}`;
  const low = progress.confidence === 'low';
  if (progress.progress === null) {
    return { state: 'none', pct: 0, detail: progress.reason, low, tooltip };
  }
  if (progress.etaAt === null) {
    return { state: 'overdue', pct: Math.round(progress.progress * 100), detail: progress.reason, low, tooltip };
  }
  const serverNow = Date.parse(progress.serverNow);
  const eta = Date.parse(progress.etaAt);
  const span = eta - serverNow;
  const frac = span > 0 ? Math.min(1, Math.max(0, (now - serverNow) / span)) : 1;
  const shown = Math.min(CAP, progress.progress + (CAP - progress.progress) * frac);
  return {
    state: 'estimate',
    pct: Math.round(shown * 100),
    detail: `ends ~${formatEndTime(progress.etaAt, now)} (${formatRemaining(eta - now)})`,
    low,
    tooltip,
  };
}

/**
 * Progress bar and end time of a running job, from the daemon's estimate (history of the job's past runs).
 *
 * Between two polls the percentage is moved toward the cap along the line to the end time, and the remaining time
 * counts down against the daemon's clock, so a 30 s poll does not make the bar look frozen. The estimate itself is
 * only ever replaced by the next poll.
 *
 * @registryCategory composite
 * @registryTags job progress eta running
 */
export function JobProgress({ progress, nowMs, fill = false }: JobProgressProps): React.ReactElement | null {
  const now = useProgressNow(progress, nowMs);

  if (progress == null) {
    return null;
  }

  const { state, pct, detail, low, tooltip } = viewProgress(progress, now);

  if (state === 'none') {
    // The reason is the whole content, so a tooltip would only say it twice.
    return fill
      ? <span data-progress-state="none" title={progress.reason} className="block w-full min-w-0 truncate text-xs text-muted">{progress.reason}</span>
      : <span data-progress-state="none" className="text-xs text-muted">{progress.reason}</span>;
  }

  const fullDetail = `${detail}${low ? ' - low confidence' : ''}`;

  const body = (
      <span
        data-progress-state={state}
        title={fill ? tooltip : undefined}
        data-confidence={progress.confidence}
        // dsl-ui's Progress paints its track bg-muted-bg, which is invisible on light surfaces and has no prop to change.
        // Radix gives the track role=progressbar; this selector outranks the single bg-muted-bg class.
        className={`${fill ? 'flex w-full min-w-0' : 'inline-flex'} items-center gap-2 ${PROGRESS_TRACK_CLS} ${low ? 'opacity-60' : ''}`}
      >
        <Progress value={pct} layout="inline" size="sm" showValue valueLabel={`${pct}%`} />
        <span
          data-progress-detail
          title={fill ? fullDetail : undefined}
          className={`text-xs text-muted ${fill ? 'min-w-0 truncate' : ''}`}
        >
          {/* On a card the row is one truncated line: the faded bar, the ~ and the title already say 'low confidence'. */}
          {fill ? detail : fullDetail}
        </span>
      </span>
  );
  // Tooltip wraps its child in a shrink-to-fit span that cannot be made full width, so a filled row takes the native title instead.
  return fill ? body : <Tooltip content={tooltip}>{body}</Tooltip>;
}
