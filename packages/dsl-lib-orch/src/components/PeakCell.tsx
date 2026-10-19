import React from 'react';
import { AlertTriangle } from 'lucide-react';

/** How a peak compares with the job's budget, and what to say about it. */
export interface PeakVerdict {
  over: boolean;
  tooltip: string | undefined;
}

/**
 * A peak figure, flagged when it is over the budget. Not by colour alone: an icon and a hidden
 * "over budget" for a screen reader go with it.
 *
 * Deliberately unannotated for the component registry: an internal building block.
 */
export function PeakCell({ shown, verdict }: { shown: string; verdict: PeakVerdict }): React.ReactElement {
  return (
    <span className={verdict.over ? 'inline-flex items-center gap-1 text-warning font-medium' : 'text-muted'} title={verdict.tooltip}>
      {verdict.over && <AlertTriangle size={12} aria-hidden="true" />}
      {verdict.over && <span className="sr-only">over budget: </span>}
      {shown}
    </span>
  );
}
