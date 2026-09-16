import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export interface BackLinkProps {
  to?: string;
  label?: string;
}

// Exported so any page header that needs its own layout still sits at the same offsets. The log
// page grew a second, hand-rolled back link with different padding, which put its arrow 9px above
// every other page's; sharing the strings is what makes that impossible rather than merely fixed.
// @formatter:off
/**
 * The row wrapper: sticky, page-background, and the vertical padding every header shares.
 *
 * `flex` is load-bearing. Left as a block, the inline-flex link sits on a text line whose strut
 * pushes it a pixel below the padding edge, while a header that wraps its crumbs in a flex row
 * gets the exact offset -- measured at y=65 against y=64 in the browser. Making every header lay
 * out the same way is what removes that pixel rather than compensating for it somewhere.
 */
export const BACK_ROW_CLS  = 'sticky top-0 z-10 bg-bg py-2 -mx-4 px-4 flex items-center';
/** The link itself, without the bottom margin a single-line header needs. */
export const BACK_LINK_CLS = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content';
// @formatter:on

const CLS        = `${BACK_LINK_CLS} mb-4`;
const STICKY_CLS = BACK_ROW_CLS;

/**
 * @registryCategory atomic
 * @registryTags back navigation link
 */
export function BackLink({ to, label = 'Back' }: BackLinkProps): React.ReactElement {
  const location = useLocation();
  // When no explicit `to`, go up one path segment: /jobs/foo/logs -> /jobs/foo
  const resolvedTo = to ?? (location.pathname.split('/').slice(0, -1).join('/') || '/');
  return (
    <div className={STICKY_CLS}>
      <Link to={resolvedTo} className={CLS}>
        <ArrowLeft size={14} />{label}
      </Link>
    </div>
  );
}
