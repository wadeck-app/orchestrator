import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export interface BackLinkProps {
  to?: string;
  label?: string;
}

// @formatter:off
const CLS = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4';
// @formatter:on

/**
 * @registryCategory atomic
 * @registryTags back navigation link
 */
export function BackLink({ to, label = 'Back' }: BackLinkProps): React.ReactElement {
  const location = useLocation();
  // When no explicit `to`, go up one path segment: /jobs/foo/logs -> /jobs/foo
  const resolvedTo = to ?? (location.pathname.split('/').slice(0, -1).join('/') || '/');
  return (
    <Link to={resolvedTo} className={CLS}>
      <ArrowLeft size={14} />{label}
    </Link>
  );
}
