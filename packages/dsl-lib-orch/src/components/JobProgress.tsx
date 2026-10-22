import React, { useEffect, useRef, useState } from 'react';
import { Progress, Tooltip } from '@wadeck-app/dsl-ui';
import type { ProgressEstimate } from '../types.js';

export interface JobProgressProps {
  /** The `progress` of GET /api/jobs/{id}. Nothing is rendered for null/absent: the job has no open run, or the first poll has not answered yet. */
  progress?: ProgressEstimate | null;
  /** "Now" in epoch millis. Defaults to this machine's clock moved onto the daemon's; the tests pass a fixed value. */
  nowMs?: number;
}

const TWO_DIGITS = (n: number): string => String(n).padStart(2, '0');

/** "in <1 min", "in 6 min", "in 2 h 05 min"; "any moment now" once the end time has passed (the next poll will say more). */
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
  return `in ${Math.floor(minutes / 60)} h ${TWO_DIGITS(minutes % 60)} min`;
}

/** Local "HH:MM"; "MM-DD HH:MM" when the end is not today. */
export function formatEndTime(etaAt: string, nowMs: number): string {
  const eta = new Date(etaAt);
  const hhmm = `${TWO_DIGITS(eta.getHours())}:${TWO_DIGITS(eta.getMinutes())}`;
  if (eta.toDateString() === new Date(nowMs).toDateString()) {
    return hhmm;
  }
  return `${TWO_DIGITS(eta.getMonth() + 1)}-${TWO_DIGITS(eta.getDate())} ${hhmm}`;
}

/** Same cap as the daemon's: a run that is still open never reads 100 %. */
const CAP = 0.99;

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
export function JobProgress({ progress, nowMs }: JobProgressProps): React.ReactElement | null {
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

  if (progress == null) {
    return null;
  }

  // The offset between the daemon's clock and this one, fixed when an estimate first arrives.
  if (skew.current === null || skew.current.serverNow !== progress.serverNow) {
    skew.current = { serverNow: progress.serverNow, ms: Date.parse(progress.serverNow) - Date.now() };
  }
  const now = nowMs ?? Date.now() + (Number.isNaN(skew.current.ms) ? 0 : skew.current.ms);
  const tooltip = `${progress.reason}${progress.strategyId ? ` [strategy: ${progress.strategyId}]` : ''}`;

  if (progress.progress === null) {
    // The reason is the whole content, so a tooltip would only say it twice.
    return <span data-progress-state="none" className="text-xs text-muted">{progress.reason}</span>;
  }

  const serverNow = Date.parse(progress.serverNow);
  let shown = progress.progress;
  let detail: string;
  let state: 'estimate' | 'overdue';
  if (progress.etaAt === null) {
    state = 'overdue';
    detail = progress.reason;
  } else {
    state = 'estimate';
    const eta = Date.parse(progress.etaAt);
    const span = eta - serverNow;
    const frac = span > 0 ? Math.min(1, Math.max(0, (now - serverNow) / span)) : 1;
    shown = Math.min(CAP, progress.progress + (CAP - progress.progress) * frac);
    detail = `ends ~${formatEndTime(progress.etaAt, now)} (${formatRemaining(eta - now)})`;
  }
  const low = progress.confidence === 'low';
  const pct = Math.round(shown * 100);

  return (
    <Tooltip content={tooltip}>
      <span
        data-progress-state={state}
        data-confidence={progress.confidence}
        className={`inline-flex items-center gap-2 ${low ? 'opacity-60' : ''}`}
      >
        <Progress value={pct} layout="inline" size="sm" showValue valueLabel={`${pct}%`} />
        <span className="text-xs text-muted">
          {detail}{low ? ' - low confidence' : ''}
        </span>
      </span>
    </Tooltip>
  );
}
