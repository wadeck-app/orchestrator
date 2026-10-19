import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { appPath } from '../runtime-config.js';

export interface JobLinkProps {
  jobId: string;
}

/**
 * A link to a job's page, with the host's route prefix. A router Link inside a router, a plain anchor outside:
 * widgets are mounted by hosts that may not wrap them in one, and a Link there throws instead of rendering.
 *
 * Deliberately unannotated for the component registry: an internal building block, not a DSL node type.
 */
export function JobLink({ jobId }: JobLinkProps): React.ReactElement {
  const to = appPath(`/jobs/${encodeURIComponent(jobId)}`);
  const className = 'text-primary underline';
  return useInRouterContext()
    ? <Link to={to} className={className}>{jobId}</Link>
    : <a href={to} className={className}>{jobId}</a>;
}
