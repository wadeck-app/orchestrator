import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// One row: back arrow, job name, page kind. Replaces a stacked back link, a
// text-2xl page title and a "Logs" subtitle, which together pushed the first log
// line to y=243 on a 900px viewport - 27% of the screen before any content.
// @formatter:off
const ROW_CLS  = 'flex items-center gap-2 text-sm';
const BACK_CLS = 'text-muted hover:text-content';
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
      {/* Icon-only, so the accessible name comes from aria-label. "Back" is the
          wording JobDetailSection uses; the two must not drift apart. */}
      <Link to={`/jobs/${jobId}`} aria-label="Back" className={BACK_CLS}>
        <ArrowLeft size={14} />
      </Link>
      <span className={JOB_CLS}>{jobLabel ?? jobId}</span>
      <span className={KIND_CLS} aria-hidden="true">·</span>
      <span className={KIND_CLS}>Logs</span>
    </div>
  );
}
