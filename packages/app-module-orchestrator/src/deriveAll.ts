import fs from 'node:fs';
import path from 'node:path';
import { listLibTypes } from '@wadeck-app/orch-dsl-lib/libTypes';
import { API_BASE, MODULE_ID, ROUTE_BASE } from '@wadeck-app/orch-dsl-lib/moduleConfig';
import { derivePage, type DeriveOptions } from './derivePages.js';

/** [orch-app page file, file name in dsl-frontend/]. Design variants and audit experiments are not part of the module. */
export const DERIVED_PAGES = [
  ['job-list.yaml', 'jobs.yaml'],
  ['schedule.yaml', 'schedule.yaml'],
  ['audit.yaml', 'audit.yaml'],
  ['job-form-new.yaml', 'job-new.yaml'],
  ['job-detail.yaml', 'job.yaml'],
  ['job-form-edit.yaml', 'job-edit.yaml'],
  ['job-logs.yaml', 'job-logs.yaml'],
] as const;

/** Views with no orch-app counterpart (a dashboard widget has no page to derive from). */
export const HANDWRITTEN_VIEWS = ['status-widget.yaml', 'navbar-stats.yaml', 'failure-overlay.yaml'] as const;

const orchAppSrc = (packageDir: string): string => path.resolve(packageDir, '..', 'orch-app', 'src');

/** orch-app's generated entries, the list of components the dsl-lib ships is read off. */
export function orchAppEntriesPath(packageDir: string): string {
  return path.join(orchAppSrc(packageDir), 'generated', 'entries.tsx');
}

/**
 * Derives every page from orch-app. Returns `dsl-frontend` file name to content, nothing written.
 *
 * The component types to prefix, the module id and the two prefixes all come from the dsl-lib: it is
 * what defines which types exist and where the module lives, so a page cannot name a type the bundle
 * lacks or point at a prefix the bundle was not built for.
 */
export function deriveAll(packageDir: string): Map<string, string> {
  const entries = fs.readFileSync(orchAppEntriesPath(packageDir), 'utf8');
  const opts: DeriveOptions = {
    moduleId: MODULE_ID,
    routePrefix: ROUTE_BASE,
    apiPrefix: API_BASE,
    orchTypes: new Set(listLibTypes(entries)),
  };

  const out = new Map<string, string>();
  for (const [source, target] of DERIVED_PAGES) {
    const page = fs.readFileSync(path.join(orchAppSrc(packageDir), 'dsl', 'pages', source), 'utf8');
    out.set(target, derivePage(page, opts));
  }
  return out;
}
