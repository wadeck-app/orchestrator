import React from 'react';
import { useProgressNow, viewProgress } from './JobProgress.js';
import type { JobProgressCellProps } from './JobProgressBarCell.js';

/*
 * The end-time cell of the job list view, for a running job. It reads the estimate exactly as JobProgress does (same clock, same
 * countdown, same low-confidence fade); a dash is the unobtrusive "nothing to show" of an idle job or one without estimate.
 */

const DASH = <span className="text-muted">-</span>;

/** "ends ~14:32 (in 6 min)", or the reason when there is no end time to give. One line: the table scrolls rather than wraps it. */
export function JobEtaCell({ progress, nowMs }: JobProgressCellProps): React.ReactElement {
  const now = useProgressNow(progress, nowMs);
  if (progress == null) {
    return DASH;
  }
  const { state, detail, low, tooltip } = viewProgress(progress, now);
  if (state === 'none') {
    return <span data-progress-state="none" title={progress.reason} className="inline-block max-w-[10.5rem] truncate align-middle text-xs italic text-muted">{progress.reason}</span>;
  }
  return (
    <span
      data-progress-state={state}
      data-confidence={progress.confidence}
      title={low ? `${tooltip} - low confidence` : tooltip}
      className={`inline-block align-middle text-xs text-muted ${state === 'estimate' ? '' : 'max-w-[10.5rem] truncate'} ${low ? 'opacity-60' : ''}`}
    >
      {detail}
    </span>
  );
}
