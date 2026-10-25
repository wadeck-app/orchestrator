import React from 'react';
import { Progress } from '@wadeck-app/dsl-ui';
import type { ProgressEstimate } from '../types.js';
import { PROGRESS_TRACK_CLS, useProgressNow, viewProgress } from './JobProgress.js';

/*
 * The bar cell of the job list view, for a running job. It reads the estimate exactly as JobProgress does (same clock, same
 * countdown, same low-confidence fade); a dash is the unobtrusive "nothing to show" of an idle job or one without estimate.
 */

const DASH = <span className="text-muted">-</span>;

export interface JobProgressCellProps {
  /** The job's `progress` from GET /api/jobs, passed only while the job is running. */
  progress?: ProgressEstimate | null;
  /** "Now" in epoch millis; defaults to this machine's clock moved onto the daemon's. The tests pass a fixed value. */
  nowMs?: number;
}

/** Compact bar with its percentage. A dash when there is no percentage to show (no estimate, or no reason to expect one yet). */
export function JobProgressBarCell({ progress, nowMs }: JobProgressCellProps): React.ReactElement {
  const now = useProgressNow(progress, nowMs);
  if (progress == null) {
    return DASH;
  }
  const { state, pct, low, tooltip } = viewProgress(progress, now);
  if (state === 'none') {
    // The reason is in the ETA cell of the same row.
    return DASH;
  }
  return (
    <span
      data-progress-state={state}
      data-confidence={progress.confidence}
      title={low ? `${tooltip} - low confidence` : tooltip}
      // Same track fix as JobProgress: dsl-ui paints the track bg-muted-bg, invisible on the light table surface.
      className={`inline-flex items-center ${PROGRESS_TRACK_CLS} ${low ? 'opacity-60' : ''}`}
    >
      <Progress value={pct} layout="inline" size="sm" showValue valueLabel={`${pct}%`} />
    </span>
  );
}
