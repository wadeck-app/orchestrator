import fs from 'node:fs';
import path from 'node:path';
import { derivePage, readOrchUiTypes, type DeriveOptions } from './derivePages.js';

export const MODULE_ID = 'orchestrator';

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
export const HANDWRITTEN_VIEWS = ['status-widget.yaml'] as const;

export const DERIVE_OPTIONS = {
  moduleId: MODULE_ID,
  routePrefix: `/modules/${MODULE_ID}`,
  apiPrefix: `/api/modules/${MODULE_ID}`,
} as const;

/** Derives every page from orch-app. Returns `dsl-frontend` file name to content, nothing written. */
export function deriveAll(packageDir: string): Map<string, string> {
  const orchApp = path.resolve(packageDir, '..', 'orch-app', 'src');
  const entries = fs.readFileSync(path.join(orchApp, 'generated', 'entries.tsx'), 'utf8');
  const opts: DeriveOptions = { ...DERIVE_OPTIONS, orchTypes: readOrchUiTypes(entries) };

  const out = new Map<string, string>();
  for (const [source, target] of DERIVED_PAGES) {
    const page = fs.readFileSync(path.join(orchApp, 'dsl', 'pages', source), 'utf8');
    out.set(target, derivePage(page, opts));
  }
  return out;
}
