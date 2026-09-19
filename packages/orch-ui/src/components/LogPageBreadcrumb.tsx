import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { BACK_ROW_CLS, BACK_LINK_CLS } from '@wadeck-app/dsl-ui';
import { useWidePane, widthClass } from './log-pane-width.js';

// One row: back link, job name, page kind. Replaces a stacked back link, a
// text-2xl page title and a "Logs" subtitle, which together pushed the first log
// line to y=243 on a 900px viewport - 27% of the screen before any content.
//
// The wrapper and the link reuse BackLink's classes rather than restating them. Hand-rolled
// padding here put this arrow at y=65 while every other page's sat at y=56, measured in the
// browser: a header that is "almost" aligned reads as a broken page.
//
// No separator glyph between the crumbs. A middle dot was tried and rejected: colour and spacing
// already separate them, and punctuation dropped between words to imply structure is decoration.
// @formatter:off
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
  // Follows the pane's width so the two stay aligned. The page asks PageContent for `full`, so
  // without this the arrow would sit at the viewport edge while the pane below it was centred.
  const [widePane] = useWidePane();
  return (
    // The width goes on a wrapper, not on the row: BACK_ROW_CLS carries `-mx-4` to bleed into the
    // page padding, and `mx-auto` on the same element would be two rules fighting over margin-x.
    <div className={widthClass(widePane)}>
    <div className={BACK_ROW_CLS}>
      <div className="flex items-center gap-3 text-sm" data-testid="log-breadcrumb">
        {/* The label is visible text rather than an aria-label: it names the destination for
            everyone, and it widens the hit area beyond a 14px glyph. "Back" is the wording
            BackLink uses; the two must not drift apart. The icon is decorative once the word is
            there, so it is hidden from the accessible name instead of doubling it. */}
        <Link to={`/jobs/${jobId}`} className={`${BACK_LINK_CLS} shrink-0`}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Link>
        <span className={JOB_CLS}>{jobLabel ?? jobId}</span>
        <span className={KIND_CLS}>Logs</span>
      </div>
    </div>
    </div>
  );
}
