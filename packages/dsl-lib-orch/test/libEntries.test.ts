// @vitest-environment jsdom
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOrchLibEntries } from '../src/index.js';
import { listLibTypes } from '../src/libTypes.js';
import { LIB_ENTRIES } from '../src/paths.js';

/*
 * The component names the module registers as "orchestrator:<name>". Frozen here on purpose: adding or
 * dropping a component changes every view's contract with the shell, so it must be a visible edit.
 */
const EXPECTED = [
  'AuditEntryIcon', 'AuditEntryRow', 'AuditList', 'DaemonStatus', 'DesignSwitcher', 'EnableToggle', 'FailureOverlay', 'JobCard',
  'JobCardGrid', 'JobConfigDisplay', 'JobFilterChips', 'JobForm', 'JobFormSection', 'JobProgress', 'JobStatusBadge', 'JobToggle',
  'LogPageBreadcrumb', 'LogViewer', 'MutationFeedback', 'NavStats', 'NextFireCountdown', 'ResourceHistory', 'RunHistory', 'RunTelemetry',
  'RunningAlertDetail', 'RunningBannerDetail', 'RunningInlineDetail', 'ScheduleTimeline', 'SearchBar',
  'TriggerBadge', 'TriggerButton',
];

describe('createOrchLibEntries', () => {
  const entries = createOrchLibEntries({ apiBase: '/api/modules/orchestrator', routeBase: '/modules/orchestrator' });

  it('exports the 31 components the module ships (JobProgress is the newest)', () => {
    expect(EXPECTED).toHaveLength(31);
    expect(entries.map(e => e.name).sort()).toEqual(EXPECTED);
  });

  it('matches the types derived from the generated entries, so the list in index.ts cannot go stale', () => {
    expect(entries.map(e => e.name).sort()).toEqual(listLibTypes(fs.readFileSync(LIB_ENTRIES, 'utf8')));
  });
});
