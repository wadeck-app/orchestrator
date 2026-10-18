import { createRegistry } from '@wadeck-app/dsl-renderer';
import type { ComponentRegistryEntry } from '@wadeck-app/dsl-renderer';
import { applyRegistryOverrides, configureOrchUi } from './ui.js';
import {
  AuditEntryIconEntry,
  AuditEntryRowEntry,
  AuditListEntry,
  DesignSwitcherEntry,
  EnableToggleEntry,
  FailureOverlayEntry,
  JobCardEntry,
  JobCardGridEntry,
  JobConfigDisplayEntry,
  JobFilterChipsEntry,
  JobFormEntry,
  JobFormSectionEntry,
  JobStatusBadgeEntry,
  JobToggleEntry,
  LogPageBreadcrumbEntry,
  LogViewerEntry,
  MutationFeedbackEntry,
  NavStatsEntry,
  NextFireCountdownEntry,
  RunHistoryEntry,
  RunningAlertDetailEntry,
  RunningBannerDetailEntry,
  RunningInlineDetailEntry,
  ScheduleTimelineEntry,
  // dsl-ui's own SearchBar, with its onChange wired to the jobs page by the registry overrides below: the
  // shell's copy is not wired, so without it typing in the jobs page would publish nothing and the list
  // would never filter. Keep LIB_EXTRA_TYPES (libTypes.ts) in step.
  SearchBarEntry,
  TriggerBadgeEntry,
  TriggerButtonEntry,
} from './generated/entries.js';

export interface OrchLibConfig {
  /** Where the module's API is mounted, e.g. `/api/modules/orchestrator`. */
  apiBase: string;
  /** Where the module's pages are mounted, e.g. `/modules/orchestrator`. */
  routeBase: string;
}

/**
 * The registry entries the library ships, configured for where the host mounts the API and the pages.
 * Not imported for its side effects: the components talk to `apiBase` only once this has been called.
 * The names are the types the views use, prefixed by the host with its module id.
 */
export function createOrchLibEntries(config: OrchLibConfig): ComponentRegistryEntry[] {
  configureOrchUi({ apiBase: config.apiBase, routeBase: config.routeBase });

  const registry = createRegistry([
    AuditEntryIconEntry,
    AuditEntryRowEntry,
    AuditListEntry,
    DesignSwitcherEntry,
    EnableToggleEntry,
    FailureOverlayEntry,
    JobCardEntry,
    JobCardGridEntry,
    JobConfigDisplayEntry,
    JobFilterChipsEntry,
    JobFormEntry,
    JobFormSectionEntry,
    JobStatusBadgeEntry,
    JobToggleEntry,
    LogPageBreadcrumbEntry,
    LogViewerEntry,
    MutationFeedbackEntry,
    NavStatsEntry,
    NextFireCountdownEntry,
    RunHistoryEntry,
    RunningAlertDetailEntry,
    RunningBannerDetailEntry,
    RunningInlineDetailEntry,
    ScheduleTimelineEntry,
    SearchBarEntry,
    TriggerBadgeEntry,
    TriggerButtonEntry,
  ]);
  // The events the views wire (kill, delete, filters...) are published by these wrappers.
  applyRegistryOverrides(registry);

  return Object.values(registry);
}
