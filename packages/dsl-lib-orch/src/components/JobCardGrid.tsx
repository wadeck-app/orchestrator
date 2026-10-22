import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, LayoutList, FileText } from 'lucide-react';
import { ButtonAction, ButtonLink, Checkbox, ColumnHelpers, DataTable, IconButton, Spinner, type TableColumn } from '@wadeck-app/dsl-ui';
import { getErrorMessage, isJobRunning, isRunCancelled, isRunFailed, isRunSkipped, latestRun, runEndReason, type RuntimeEntry } from '../types.js';
import { postTrigger, readErrorSentence } from '../trigger-job.js';
import type { JobWithHistory } from '../job-with-history.js';
import { JobCard, TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { relativeTime } from './JobCard.js';
import { useConfirm } from '../use-confirm.js';
import { appPath, getApiBase } from '../runtime-config.js';

// Extends the shared shape rather than redeclaring it: a second exported interface with the
// same name but an extra field meant the type you got depended on which file you imported
// from, and only the module-level one is re-exported from the package index.
export interface JobWithUptime extends JobWithHistory {
  uptimePercent?: number | null;
}

type ViewMode = 'grid' | 'list';

const VIEW_MODE_KEY = 'orch-view-mode';

function readViewMode(): ViewMode {
  try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? 'grid'; }
  catch { return 'grid'; }
}

// @formatter:off
const BULK_BAR_CLS  = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-surface rounded-lg border border-border shadow-lg flex-wrap max-w-2xl';
// @formatter:on

/**
 * One job, flattened for DataTable's list view.
 *
 * A type alias rather than an interface: DataTable is generic over `T extends Record<string,
 * unknown>`, and only an object type literal gets the implicit index signature that satisfies it.
 *
 * `item` rides along so the columns that render a badge can classify from the real run rather than
 * re-parse a string.
 */
type JobRow = {
  id: string;
  label: string;
  type: string;
  schedule: string;
  lastRun: string;
  item: JobWithUptime;
};

function toJobRow(item: JobWithUptime): JobRow {
  const last = latestRun(item.runHistory);
  return {
    id: item.job.id,
    label: item.job.label,
    type: item.job.type,
    schedule: item.job.type === 'manual' ? 'Trigger only' : (item.job.schedule ?? `${item.job.delaySeconds ?? 0}s`),
    lastRun: last ? relativeTime(last.startedAt) : 'Never',
    item,
  };
}

/**
 * Failures at the head of the history, which is what drives the "N fails" alert on a card.
 *
 * Skipped runs are transparent, exactly as in JobCard's success streak: they must not inflate
 * the count, and they must not silently clear a genuine failure run either.
 *
 * Exported for its own test: the value only ever reaches the DOM as part of an alert that is
 * itself threshold-gated, so asserting it through the rendered card proves very little.
 */
export function getConsecutiveFailures(runHistory: RuntimeEntry[]): number {
  let count = 0;
  for (const e of runHistory) {
    if (isRunSkipped(e)) {
      continue;
    }
    if (isRunFailed(e)) {
      count++;
    }
    else {
      break;
    }
  }
  return count;
}

export interface JobCardGridProps {
  items?: JobWithUptime[];
  // Filter props -- driven by DSL $vars (SearchBar + JobFilterChips)
  search?: string;
  filter?: string;
  /**
   * The filter controls, rendered on the left of this component's own toolbar.
   *
   * Same arrangement as dsl-ui's DataTable, which takes its filters as a slot for the same
   * reason: the toolbar has to hold the filters and the actions, and only this component can
   * host the view toggle, whose state and persistence live here. Without the slot the page
   * stacked its filters above, leaving the toolbar alone on a row that used 7% of the page
   * width for an 85px button.
   *
   * @slot tag:filter, tag:atomic, tag:composite, tag:layout
   */
  filters?: React.ReactNode;
  uptimeMap?: Record<string, number | null>;
  // DSL $outputs callbacks -- injected via registry-overrides when $id is declared
  onToggle?: (id: string, enabled: boolean) => void;
  onJobClick?: (id: string) => void;
  onAddJob?: () => void;
  onBulkEnable?: (ids: string[]) => void;
  onBulkDisable?: (ids: string[]) => void;
  onBulkTrigger?: (ids: string[]) => void;
  onBulkDelete?: (ids: string[]) => void;
  /**
   * Fired once a bulk action this component ran itself has finished.
   *
   * A bulk action cannot be a single DSL brain -- an `$http` brain takes one URL, so "delete these
   * four" has no expression -- so the fan-out stays here. Without this the page's job source only
   * catches up on its next poll, and for up to 30s the deleted cards are still on screen.
   */
  onAfterBulk?: () => void;
  /**
   * Fired once a Run now this component ran itself has settled, whether the job started or was
   * refused for being at its concurrency limit.
   *
   * The page cannot own the POST: a brain sees a status, never the 200 body that says the run was
   * refused, so a refusal on a page-owned trigger looked exactly like a started run. The component
   * posts itself and uses this to ask the page to reload.
   */
  onAfterTrigger?: () => void;
  onExport?: () => void;
  onImport?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job grid cards list
 */
export function JobCardGrid({ items, search = '', filter = 'all', filters, uptimeMap, onExport, onImport, onToggle, onJobClick, onAddJob, onBulkEnable, onBulkDisable, onBulkTrigger, onBulkDelete, onAfterBulk, onAfterTrigger }: JobCardGridProps): React.ReactElement {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const { ask, notify, dialog } = useConfirm();

  const toggleView = () => {
    const next = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // The card's TriggerButton shows a refusal itself, so this only has to hand the result back. The
  // page is told in `finally`: a refused or failed run can still have changed what the page shows.
  const handleTrigger = useCallback(async (id: string, opts?: { force: true }) => {
    try {
      return await postTrigger(id, opts);
    } finally {
      onAfterTrigger?.();
    }
  }, [onAfterTrigger]);

  // The list view's Run now is a plain button with no state of its own, so the outcome goes in the
  // app's dialog: a refusal offers to run anyway, and a failure says what failed.
  const handleRowTrigger = useCallback(async (id: string, label: string, opts?: { force: true }): Promise<void> => {
    try {
      const refused = await handleTrigger(id, opts);
      if (refused) {
        ask({
          title: `"${label}" is already running`,
          message: `${refused.running} of ${refused.maxConcurrency} allowed run${refused.maxConcurrency === 1 ? ' is' : 's are'} active, so nothing was started. Start another anyway?`,
          confirmLabel: 'Run anyway',
          confirmVariant: 'primary',
          onConfirm: () => { void handleRowTrigger(id, label, { force: true }); },
        });
      }
    } catch (err) {
      notify({ title: `Could not start "${label}"`, message: getErrorMessage(err) });
    }
  }, [handleTrigger, ask, notify]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    if (onToggle) { onToggle(id, enabled); return; }
    const res = await fetch(`${getApiBase()}/api/jobs/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (!res.ok) { throw new Error(await readErrorSentence(res)); }
  }, [onToggle]);

  const handleBulkEnable  = useCallback(async () => {
    const ids = [...selected];
    if (onBulkEnable) { onBulkEnable(ids); setSelected(new Set()); return; }
    await Promise.allSettled(ids.map(id => fetch(`${getApiBase()}/api/jobs/${id}/enable`, { method: 'POST' }))); setSelected(new Set()); onAfterBulk?.();
  }, [selected, onBulkEnable, onAfterBulk]);
  const handleBulkDisable = useCallback(async () => {
    const ids = [...selected];
    if (onBulkDisable) { onBulkDisable(ids); setSelected(new Set()); return; }
    await Promise.allSettled(ids.map(id => fetch(`${getApiBase()}/api/jobs/${id}/disable`, { method: 'POST' }))); setSelected(new Set()); onAfterBulk?.();
  }, [selected, onBulkDisable, onAfterBulk]);
  const handleBulkTrigger = useCallback(async () => {
    const ids = [...selected];
    if (onBulkTrigger) { onBulkTrigger(ids); setSelected(new Set()); return; }
    const outcomes = await Promise.allSettled(ids.map(id => postTrigger(id)));
    setSelected(new Set());
    onAfterBulk?.();
    // Silent when everything started. Otherwise the count is the report: dropping the responses made
    // "three started" and "none started" look identical.
    const refused = outcomes.filter(o => o.status === 'fulfilled' && o.value !== undefined).length;
    const failures = outcomes.flatMap(o => (o.status === 'rejected' ? [getErrorMessage(o.reason)] : []));
    if (refused === 0 && failures.length === 0) {
      return;
    }
    const started = outcomes.length - refused - failures.length;
    const parts = [`${started} started`];
    if (refused > 0) {
      parts.push(`${refused} already running`);
    }
    if (failures.length > 0) {
      parts.push(`${failures.length} failed`);
    }
    notify({
      title: 'Not every job was started',
      message: failures.length > 0 ? `${parts.join(', ')}. ${[...new Set(failures)].join('; ')}` : `${parts.join(', ')}.`,
    });
  }, [selected, onBulkTrigger, onAfterBulk, notify]);
  // Asks in the app's own dialog rather than the browser's. A native confirm() blocks the page and
  // cannot be styled, which for "delete N jobs" is the moment the reader most needs to be sure what
  // they are looking at. See useConfirm.
  //
  // The prompt is outside the onBulkDelete branch on purpose: a page that owns the deletion still
  // wants it confirmed, and the earlier ordering made this dialog dead code anywhere the DSL wired
  // the output.
  const handleBulkDelete = useCallback(() => {
    const ids = [...selected];
    ask({
      title: `Delete ${ids.length} job${ids.length === 1 ? '' : 's'}?`,
      message: 'Their definitions are removed. Run history and logs are not.',
      confirmLabel: 'Delete',
      onConfirm: () => {
        if (onBulkDelete) { onBulkDelete(ids); setSelected(new Set()); return; }
        void Promise.allSettled(ids.map(id => fetch(`${getApiBase()}/api/jobs/${id}`, { method: 'DELETE' })))
          .then(() => { setSelected(new Set()); onAfterBulk?.(); });
      },
    });
  }, [selected, onBulkDelete, onAfterBulk, ask]);

  // dsl-ui's Spinner rather than a hand-rolled div, for the accessible name the raw one lacked.
  if (!items) {
    return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  }

  const visible = items.filter(({ job, runHistory }) => {
    const last = latestRun(runHistory);
    const q = search.toLowerCase();
    // The whole description, not the first line a card shows: it is text written to find the job again.
    const matchSearch = !q || job.label.toLowerCase().includes(q) || job.command.toLowerCase().includes(q)
      || (job.description?.toLowerCase().includes(q) ?? false);
    /*
     * A spent `once` job has already had its single firing. It stays in the registry for the audit
     * trail rather than being deleted, which means it arrives here and has to be kept out of every
     * view that is about work still to come - otherwise the grid fills with up to fifty cards showing
     * a "next run" that happened weeks ago, and "Failed" keeps a permanent red card for a one-off job
     * that cannot be fixed by waiting for its next run.
     *
     * Checked once, before the filters, so a filter added later cannot forget it.
     */
    const isPast = job.type === 'once' && job.spent === true;
    const matchFilter = filter === 'past-once'
      ? isPast
      : !isPast && (
        filter === 'all'     ||
        (filter === 'cron'    && job.type === 'cron')    ||
        (filter === 'startup' && job.type === 'startup') ||
        (filter === 'once'    && job.type === 'once')    ||
        (filter === 'manual'  && job.type === 'manual')  ||
        (filter === 'failed'  && isRunFailed(last))
      );
    return matchSearch && matchFilter;
  });

  const allVisibleSelected = visible.length > 0 && visible.every(i => selected.has(i.job.id));
  const toggleSelectAll = () => {
    setSelected(prev => {
      const next = new Set(prev);
      for (const i of visible) {
        if (allVisibleSelected) { next.delete(i.job.id); } else { next.add(i.job.id); }
      }
      return next;
    });
  };

  /*
   * Selection stays here rather than moving to DataTable's own `selectable`.
   *
   * DataTable keeps its selection internal, with no way to read or seed it, so handing it over would
   * give the list view one selection model and its own toolbar while the grid view kept another --
   * two different bulk UIs for the same jobs, and a selection lost on every view switch. Here one
   * `selected` set drives both views and the single floating bulk bar, exactly as before.
   *
   * The consequence is that the row checkbox is a column: `TableColumn.label` is a string, so the
   * select-all cannot be a header cell. It lives in the toolbar instead, which is a gain -- grid view
   * never had one at all.
   */
  const listColumns: TableColumn<JobRow>[] = [
    {
      key: 'select',
      label: '',
      width: 6,
      render: ({ item }) => (
        <span onClick={e => { e.stopPropagation(); toggleSelect(item.job.id); }}>
          <Checkbox
            checked={selected.has(item.job.id)}
            onChange={() => {}}
            aria-label={`Select ${item.job.label}`}
            className="cursor-pointer"
          />
        </span>
      ),
    },
    ColumnHelpers.text<JobRow>('label', 'Job'),
    {
      key: 'type',
      label: 'Type',
      render: ({ item }) => (
        <span className={`${TYPE_BADGE_BASE} ${TYPE_COLORS[item.job.type as keyof typeof TYPE_COLORS] ?? 'bg-tag-once-bg text-tag-once'}`}>
          {item.job.type}
        </span>
      ),
    },
    ColumnHelpers.text<JobRow>('schedule', 'Schedule', { mono: true, muted: true }),
    {
      key: 'status',
      label: 'Status',
      render: ({ item }) => {
        const last = latestRun(item.runHistory);
        return <JobStatusBadge exitCode={last?.exitCode ?? null} running={isJobRunning(item.runHistory)} cancelled={isRunCancelled(last)} skipped={isRunSkipped(last)} endReason={runEndReason(last)} />;
      },
    },
    ColumnHelpers.text<JobRow>('lastRun', 'Last run', { muted: true }),
    {
      key: 'actions',
      label: 'Actions',
      // Same pair as the card footer, at the same size. The spans stop the row's click.
      render: ({ item }) => (
        <div className="flex items-center gap-2">
          <span onClick={e => e.stopPropagation()}>
            <ButtonLink to={appPath(`/jobs/${item.job.id}/logs`)} label="Logs" icon={<FileText size={12} />} variant="secondary" size="sm" />
          </span>
          <span onClick={e => e.stopPropagation()}>
            <ButtonAction label="Run now" size="sm" onClick={() => { void handleRowTrigger(item.job.id, item.job.label); }} />
          </span>
        </div>
      ),
    },
  ];

  return (
    <div>
      {/* One toolbar: filters left, actions right. The filters arrive as a slot so they share
          this row instead of stacking above it - the actions alone used 85px of a 1152px row. */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {filters}
          {/* Select-all lives here rather than in a header cell, because TableColumn.label is a
              string. It therefore also covers grid view, which never had one.

              Visibly labelled, not just aria-labelled: a bare checkbox sitting beside the filter
              chips reads as one more filter. The checked state carries the select/deselect sense,
              which is what a checkbox is for. */}
          {visible.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
              <Checkbox checked={allVisibleSelected} onChange={toggleSelectAll} className="cursor-pointer" />
              Select all
            </label>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onExport && <ButtonAction variant="secondary" label="Export" onClick={onExport} />}
          {onImport && <ButtonAction variant="secondary" label="Import" onClick={onImport} />}
          <ButtonAction label="Add job" onClick={() => onAddJob ? onAddJob() : navigate(appPath('/jobs/new'))} />
          <IconButton icon={viewMode === 'grid' ? <LayoutList size={16} /> : <LayoutGrid size={16} />} aria-label={viewMode === 'grid' ? 'List view' : 'Grid view'} onClick={toggleView} variant="ghost" />
        </div>
      </div>

      {selected.size > 0 && (
        <div className={BULK_BAR_CLS}>
          <span className="text-sm text-muted">{selected.size} selected</span>
          <ButtonAction label="Enable" variant="secondary" onClick={handleBulkEnable} />
          <ButtonAction label="Disable" variant="secondary" onClick={handleBulkDisable} />
          <ButtonAction label="Run now" variant="primary" onClick={handleBulkTrigger} />
          <ButtonAction label="Delete" variant="danger" onClick={handleBulkDelete} />
          {/* violations-suppress: react/no-raw-button bulk clear text-link - no Button variant for inline text-link */}
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted hover:text-content">Clear</button>
        </div>
      )}

      {items.length === 0 && <p className="text-muted text-center py-12">No jobs registered yet.</p>}
      {/* List view gets this from DataTable's emptyMessage; saying it twice there is worse than
          saying it once in each place. */}
      {viewMode === 'grid' && items.length > 0 && visible.length === 0 && <p className="text-muted text-center py-12">No jobs match the current filter.</p>}

      {viewMode === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <JobCard key={item.job.id} job={item.job} runHistory={item.runHistory}
              uptimePercent={uptimeMap?.[item.job.id] ?? item.uptimePercent}
              consecutiveFailures={getConsecutiveFailures(item.runHistory)}
              onClick={() => onJobClick ? onJobClick(item.job.id) : navigate(appPath(`/jobs/${item.job.id}`))}
              onTrigger={handleTrigger} onToggle={handleToggle}
              selected={selected.has(item.job.id)}
              onSelect={e => { e.stopPropagation(); toggleSelect(item.job.id); }} />
          ))}
        </div>
      ) : (
        <DataTable
          rows={visible.map(toJobRow)}
          columns={listColumns}
          emptyMessage="No jobs match the current filter."
          onRowClick={({ id }) => onJobClick ? onJobClick(id) : navigate(appPath(`/jobs/${id}`))}
        />
      )}
      {dialog}
    </div>
  );
}
