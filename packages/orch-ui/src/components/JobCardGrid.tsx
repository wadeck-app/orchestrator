import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, LayoutList } from 'lucide-react';
import { Button } from './Button.js';
import type { Job, RuntimeEntry } from '../types.js';
import { JobCard } from './JobCard.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { relativeTime } from './JobCard.js';

export interface JobWithHistory { job: Job; runHistory: RuntimeEntry[]; uptimePercent?: number | null; }

type ViewMode = 'grid' | 'list';

const VIEW_MODE_KEY = 'orch-view-mode';

function readViewMode(): ViewMode {
  try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? 'grid'; }
  catch { return 'grid'; }
}

// @formatter:off
const BULK_BAR_CLS  = 'fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 bg-surface rounded-lg border border-border shadow-lg flex-wrap max-w-2xl';
// @formatter:on

function getConsecutiveFailures(runHistory: RuntimeEntry[]): number {
  let count = 0;
  for (const e of runHistory) {
    if (e.exitCode !== null && e.exitCode !== 0) count++;
    else break;
  }
  return count;
}

export interface JobCardGridProps {
  items?: JobWithHistory[];
  // Filter props -- driven by DSL $vars (JobSearchBar + JobFilterChips)
  search?: string;
  filter?: string;
  uptimeMap?: Record<string, number | null>;
  // DSL $outputs callbacks -- injected via registry-overrides when $id is declared
  onTrigger?: (id: string) => void;
  onToggle?: (id: string, enabled: boolean) => void;
  onJobClick?: (id: string) => void;
  onAddJob?: () => void;
  onBulkEnable?: (ids: string[]) => void;
  onBulkDisable?: (ids: string[]) => void;
  onBulkTrigger?: (ids: string[]) => void;
  onBulkDelete?: (ids: string[]) => void;
  onExport?: () => void;
  onImport?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job grid cards list
 */
export function JobCardGrid({ items, search = '', filter = 'all', uptimeMap, onExport, onImport, onTrigger, onToggle, onJobClick, onAddJob, onBulkEnable, onBulkDisable, onBulkTrigger, onBulkDelete }: JobCardGridProps): React.ReactElement {
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggleView = () => {
    const next = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleTrigger = useCallback(async (id: string) => {
    if (onTrigger) { onTrigger(id); return; }
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
  }, [onTrigger]);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    if (onToggle) { onToggle(id, enabled); return; }
    const res = await fetch(`/api/jobs/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
  }, [onToggle]);

  const handleBulkEnable  = useCallback(async () => {
    const ids = [...selected];
    if (onBulkEnable) { onBulkEnable(ids); setSelected(new Set()); return; }
    await Promise.allSettled(ids.map(id => fetch(`/api/jobs/${id}/enable`, { method: 'POST' }))); setSelected(new Set());
  }, [selected, onBulkEnable]);
  const handleBulkDisable = useCallback(async () => {
    const ids = [...selected];
    if (onBulkDisable) { onBulkDisable(ids); setSelected(new Set()); return; }
    await Promise.allSettled(ids.map(id => fetch(`/api/jobs/${id}/disable`, { method: 'POST' }))); setSelected(new Set());
  }, [selected, onBulkDisable]);
  const handleBulkTrigger = useCallback(async () => {
    const ids = [...selected];
    if (onBulkTrigger) { onBulkTrigger(ids); setSelected(new Set()); return; }
    await Promise.allSettled(ids.map(id => fetch(`/api/jobs/${id}/trigger`, { method: 'POST' }))); setSelected(new Set());
  }, [selected, onBulkTrigger]);
  const handleBulkDelete  = useCallback(async () => {
    const ids = [...selected];
    if (onBulkDelete) { onBulkDelete(ids); setSelected(new Set()); return; }
    if (!window.confirm(`Delete ${selected.size} job(s)?`)) return;
    await Promise.allSettled(ids.map(id => fetch(`/api/jobs/${id}`, { method: 'DELETE' })));
    setSelected(new Set());
  }, [selected, onBulkDelete]);

  if (!items) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  const visible = items.filter(({ job, runHistory }) => {
    const last = runHistory[0] ?? null;
    const q = search.toLowerCase();
    const matchSearch = !q || job.label.toLowerCase().includes(q) || job.command.toLowerCase().includes(q);
    const matchFilter =
      filter === 'all'     ||
      (filter === 'cron'    && job.type === 'cron')    ||
      (filter === 'startup' && job.type === 'startup') ||
      (filter === 'once'    && job.type === 'once')    ||
      (filter === 'failed'  && last !== null && last.exitCode !== 0 && last.exitCode !== null);
    return matchSearch && matchFilter;
  });

  return (
    <div>
      {/* Toolbar: Add job + view toggle (search/filter come from DSL $vars via JobSearchBar/JobFilterChips) */}
      <div className="flex items-center justify-end gap-2 mb-4">
        {onExport && <Button variant="secondary" label="Export" onClick={onExport} />}
        {onImport && <Button variant="secondary" label="Import" onClick={onImport} />}
        <Button label="Add job" onClick={() => onAddJob ? onAddJob() : navigate('/jobs/new')} />
        {/* violations-suppress: react/no-raw-button icon-only toggle - Button requires label, icon-only unsupported */}
        <button onClick={toggleView} aria-label={viewMode === 'grid' ? 'List view' : 'Grid view'} className="p-2 rounded border border-border bg-muted-bg hover:opacity-80">
          {viewMode === 'grid' ? <LayoutList size={16} /> : <LayoutGrid size={16} />}
        </button>
      </div>

      {selected.size > 0 && (
        <div className={BULK_BAR_CLS}>
          <span className="text-sm text-muted">{selected.size} selected</span>
          <Button label={`Enable (${selected.size})`} variant="secondary" onClick={handleBulkEnable} />
          <Button label={`Disable (${selected.size})`} variant="secondary" onClick={handleBulkDisable} />
          <Button label={`Run now (${selected.size})`} variant="primary" onClick={handleBulkTrigger} />
          <Button label={`Delete (${selected.size})`} variant="danger" onClick={handleBulkDelete} />
          {/* violations-suppress: react/no-raw-button bulk clear text-link - no Button variant for inline text-link */}
          <button onClick={() => setSelected(new Set())} className="ml-auto text-xs text-muted hover:text-content">Clear</button>
        </div>
      )}

      {items.length === 0 && <p className="text-muted text-center py-12">No jobs registered yet.</p>}
      {items.length > 0 && visible.length === 0 && <p className="text-muted text-center py-12">No jobs match the current filter.</p>}

      {viewMode === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((item) => (
            <JobCard key={item.job.id} job={item.job} runHistory={item.runHistory}
              uptimePercent={uptimeMap?.[item.job.id] ?? item.uptimePercent}
              consecutiveFailures={getConsecutiveFailures(item.runHistory)}
              onClick={() => onJobClick ? onJobClick(item.job.id) : navigate(`/jobs/${item.job.id}`)}
              onTrigger={handleTrigger} onToggle={handleToggle}
              selected={selected.has(item.job.id)}
              onSelect={e => { e.stopPropagation(); toggleSelect(item.job.id); }} />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-muted border-b">
              <th className="pb-2 pr-3 w-6">
                {/* violations-suppress: react/no-raw-input select-all checkbox - no FieldText variant for boolean without label */}
                <input type="checkbox"
                  checked={visible.length > 0 && visible.every(i => selected.has(i.job.id))}
                  onChange={() => {
                    if (visible.every(i => selected.has(i.job.id))) {
                      setSelected(prev => { const n = new Set(prev); visible.forEach(i => n.delete(i.job.id)); return n; });
                    } else {
                      setSelected(prev => { const n = new Set(prev); visible.forEach(i => n.add(i.job.id)); return n; });
                    }
                  }}
                  className="w-4 h-4 cursor-pointer accent-primary" />
              </th>
              <th className="pb-2 font-medium">Job</th>
              <th className="pb-2 font-medium">Type</th>
              <th className="pb-2 font-medium">Schedule</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Last run</th>
              <th className="pb-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map(({ job, runHistory }) => {
              const last = runHistory[0] ?? null;
              return (
                <tr key={job.id} className="border-b hover:bg-muted-bg cursor-pointer" onClick={() => onJobClick ? onJobClick(job.id) : navigate(`/jobs/${job.id}`)}>
                  <td className="py-2 pr-3">
                    {/* violations-suppress: react/no-raw-input row selection checkbox - no FieldText variant for boolean without label */}
                    <input type="checkbox" checked={selected.has(job.id)} onChange={() => {}}
                      onClick={e => { e.stopPropagation(); toggleSelect(job.id); }}
                      className="w-4 h-4 cursor-pointer accent-primary" />
                  </td>
                  <td className="py-2 pr-4 text-content font-medium">{job.label}</td>
                  <td className="py-2 pr-4 text-muted">{job.type}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-muted">{job.schedule ?? `${job.delaySeconds ?? 0}s`}</td>
                  <td className="py-2 pr-4"><JobStatusBadge exitCode={last?.exitCode ?? null} running={last?.exitCode === null && runHistory.length > 0} /></td>
                  <td className="py-2 pr-4 text-xs text-muted">{last ? relativeTime(last.startedAt) : 'Never'}</td>
                  <td className="py-2">
                    {/* violations-suppress: react/no-raw-button inline table run button - no compact Button variant for table cells */}
                    <button className="text-xs px-2 py-1 bg-primary text-on-primary rounded hover:bg-primary-hover"
                      onClick={e => { e.stopPropagation(); void handleTrigger(job.id); }}>
                      Run now
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
