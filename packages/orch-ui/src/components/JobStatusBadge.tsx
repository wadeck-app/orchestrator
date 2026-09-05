import React from 'react';

export interface JobStatusBadgeProps {
  exitCode: number | null;
  running?: boolean;
}

// Status badges use fixed traffic-light colors (not theme tokens): no bg-success/bg-warning/bg-error
// semantic tokens exist in the design system at this granularity, so raw Tailwind palette is required.
// violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname no status-semantic tokens (success/warning/error) in design system; raw palette required for traffic-light status colors
// @formatter:off
const BADGE_BASE = 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium';
export const BADGE_RUNNING = `${BADGE_BASE} bg-yellow-100 text-yellow-800`;
export const BADGE_OK      = `${BADGE_BASE} bg-green-100 text-green-800`;
export const BADGE_FAILED  = `${BADGE_BASE} bg-red-100 text-red-800`;
export const BADGE_NEVER   = `${BADGE_BASE} bg-gray-100 text-gray-600`;
// @formatter:on
// violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname

/**
 * @registryCategory atomic
 * @registryTags badge status job
 */
export function JobStatusBadge({ exitCode, running }: JobStatusBadgeProps): React.ReactElement {
  if (running) return <span className={BADGE_RUNNING}>Running</span>;
  if (exitCode === 0) return <span className={BADGE_OK}>OK</span>;
  if (exitCode !== null) return <span className={BADGE_FAILED}>Failed &mdash; exit {exitCode}</span>;
  return <span className={BADGE_NEVER}>Never run</span>;
}
