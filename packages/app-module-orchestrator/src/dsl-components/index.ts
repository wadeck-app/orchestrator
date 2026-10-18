// Built by `app-core-cli package` into dist-module/dsl-lib/entries.mjs. The default export lists the components
// the shell registers as "orchestrator:<name>" (so the views say `$type: orchestrator:JobCardGrid`).
import { createRegistry } from '@wadeck-app/dsl-renderer';
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
  // dsl-ui's own SearchBar: orch-app wires its onChange to the jobs page (registry overrides below), the shell's
  // copy is not wired, so without it typing in the jobs page would publish nothing and the list would never filter.
  SearchBarEntry,
  TriggerBadgeEntry,
  TriggerButtonEntry,
} from '@wadeck-app/orch-app/generated/entries';
// Resolved to orch-ui's sources by tsconfig.json "paths", so the components (imported through relative paths by the
// entries above) and this call share one runtime-config module.
import { applyRegistryOverrides, configureOrchUi } from '@wadeck-app/orch-ui';
import { API_BASE, ROUTE_BASE } from '../commons/moduleConfig.js';

// The module's own API and pages live under app-core's prefixes, not at the root as in orch-app.
configureOrchUi({ apiBase: API_BASE, routeBase: ROUTE_BASE });

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
// The events orch-app wires to its pages (kill, delete, filters...) are published by these wrappers.
applyRegistryOverrides(registry);

export default Object.values(registry);
