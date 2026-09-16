import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// One row: back link, job name, page kind. Replaces a stacked back link, a
// text-2xl page title and a "Logs" subtitle, which together pushed the first log
// line to y=243 on a 900px viewport - 27% of the screen before any content.
// @formatter:off
const ROW_CLS  = 'flex items-center gap-2 text-sm';
// The arrow and its label are one flex item with a tighter gap, so "Back" reads as belonging to
// the arrow while the job name is clearly a separate crumb. Icon-only left the job name sitting
// against the arrow, which made the arrow look like part of the name rather than a way out.
const BACK_CLS = 'flex items-center gap-1 shrink-0 text-muted hover:text-content';
const JOB_CLS  = 'font-medium text-content truncate';
const KIND_CLS = 'text-muted';
// @formatter:on

export interface LogPageBreadcrumbProps {
  jobId: string;
  /** Human-readable job name; falls back to the id when the job has no label. */
  jobLabel?: string;
}

/**
 * @registryCategory composite
 * @registryTags header navigation log
 */
export function LogPageBreadcrumb({ jobId, jobLabel }: LogPageBreadcrumbProps): React.ReactElement {
  return (
    <div className={ROW_CLS} data-testid="log-breadcrumb">
      {/* The label is visible text rather than an aria-label: it names the destination for
          everyone, and it widens the hit area to more than a 14px glyph. "Back" is the wording
          JobDetailSection uses; the two must not drift apart. The icon is decorative once the
          word is there, so it is hidden from the accessible name instead of doubling it. */}
      <Link to={`/jobs/${jobId}`} className={BACK_CLS}>
        <ArrowLeft size={14} aria-hidden="true" />
        Back
      </Link>
      <span className={KIND_CLS} aria-hidden="true">·</span>
      <span className={JOB_CLS}>{jobLabel ?? jobId}</span>
      <span className={KIND_CLS} aria-hidden="true">·</span>
      <span className={KIND_CLS}>Logs</span>
    </div>
  );
}
