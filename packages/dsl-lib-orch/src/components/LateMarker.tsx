import React from 'react';

/** Tooltip of the marker; one wording, so the history table and the job card cannot drift apart. */
export const LATE_TOOLTIP = 'Ended while the daemon was down; the daemon learned of it at its next start';

/**
 * Tag for a run whose end the daemon only learned at its next start.
 *
 * Deliberately unannotated for the component registry: an internal building block, like JobStatusPill.
 */
export function LateMarker(): React.ReactElement {
  return (
    <span className="text-xs px-1.5 py-0.5 rounded bg-muted/20 text-muted" title={LATE_TOOLTIP}>
      Late
    </span>
  );
}
