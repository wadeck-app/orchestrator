import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { appPath } from '../runtime-config.js';

/**
 * The run's log file stamp, as RunLogger names it: colons to dashes, milliseconds dropped.
 *
 * Duplicating the rule is what makes the link land on the right run; deriving it from the displayed
 * locale string would produce a name no file has, and the pane would quietly fall back to the live
 * tail rather than say the run was not found.
 */
export function runName(startedAt: string): string {
  return startedAt.replace(/:/g, '-').slice(0, 19);
}

/** The logs page opened on one run, with the host's route prefix (`/modules/<id>` inside app-core, none in orch-app). */
export function runLogPath(jobId: string, startedAt: string): string {
  return appPath(`/jobs/${jobId}/logs?run=${encodeURIComponent(runName(startedAt))}`);
}

export interface RunLogLinkProps {
  jobId: string;
  startedAt: string;
  className?: string;
  children: React.ReactNode;
}

/**
 * A link to one run's log. A router Link inside a router, a plain anchor outside: the failure overlay is
 * mounted by hosts that may not wrap it in one, and a Link there throws instead of rendering.
 *
 * Deliberately unannotated for the component registry: an internal building block, not a DSL node type.
 */
export function RunLogLink({ jobId, startedAt, className, children }: RunLogLinkProps): React.ReactElement {
  const to = runLogPath(jobId, startedAt);
  return useInRouterContext()
    ? <Link to={to} className={className}>{children}</Link>
    : <a href={to} className={className}>{children}</a>;
}
