import React from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { appPath } from '../runtime-config.js';

export interface PageLinkProps {
  /** Path inside the module, e.g. "/" for the Jobs page; the host's route prefix is added. */
  path: string;
  children: React.ReactNode;
}

/**
 * A link to one of the module's pages, with the host's route prefix. Same rule as JobLink: a router Link
 * inside a router, a plain anchor outside.
 *
 * Deliberately unannotated for the component registry: an internal building block, not a DSL node type.
 */
export function PageLink({ path, children }: PageLinkProps): React.ReactElement {
  const to = appPath(path);
  const className = 'text-primary underline';
  return useInRouterContext()
    ? <Link to={to} className={className}>{children}</Link>
    : <a href={to} className={className}>{children}</a>;
}
