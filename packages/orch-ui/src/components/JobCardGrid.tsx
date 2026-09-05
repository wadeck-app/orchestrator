import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LayoutGrid, LayoutList } from 'lucide-react';
import type { Job, RuntimeEntry } from '../types.js';
import { JobCard } from './JobCard.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { relativeTime } from './JobCard.js';
import { getErrorMessage } from '../types.js';

export interface JobWithHistory { job: Job; runHistory: RuntimeEntry[]; }

type FilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed';
type ViewMode   = 'grid' | 'list';

const VIEW_MODE_KEY = 'orch-view-mode';

function readViewMode(): ViewMode {
  try { return (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? 'grid'; }
  catch { return 'grid'; }
}

// @formatter:off
const CHIP_ACTIVE   = 'px-3 py-1 rounded-full text-sm font-medium bg-primary text-on-primary';
const CHIP_INACTIVE = 'px-3 py-1 rounded-full text-sm font-medium bg-muted-bg text-muted border border-border hover:bg-border';
const SEARCH_CLS    = 'flex-1 border border-border rounded-md px-3 py-2 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
const ADD_BTN_CLS   = 'px-4 py-2 bg-primary text-on-primary rounded-md text-sm font-medium hover:bg-primary-hover';
// @formatter:on

export interface JobCardGridProps {
  items?: JobWithHistory[];
  onExport?: () => void;
  onImport?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job grid cards list
 */
export function JobCardGrid({ items, onExport, onImport }: JobCardGridProps): React.ReactElement {
  const navigate   = useNavigate();
  const [search, setSearch]   = useState('');
  const [filter, setFilter]   = useState<FilterType>('all');
  const [viewMode, setViewMode] = useState<ViewMode>(readViewMode);

  const toggleView = () => {
    const next = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(next);
    try { localStorage.setItem(VIEW_MODE_KEY, next); } catch { /* ignore */ }
  };

  const handleTrigger = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
  }, []);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const res = await fetch(`/api/jobs/${id}/${enabled ? 'enable' : 'disable'}`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
  }, []);

  const filterLabels: { key: FilterType; label: string }[] = [
    { key: 'all',     label: 'All' },
    { key: 'cron',    label: 'Cron' },
    { key: 'startup', label: 'Startup' },
    { key: 'once',    label: 'Once' },
    { key: 'failed',  label: 'Failed' },
  ];

  if (!items) {
    return <div className="flex justify-center py-12"><div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  const visible = items.filter(({ job, runHistory }) => {
    const last = runHistory[0] ?? null;
    const matchSearch = !search || job.label.toLowerCase().includes(search.toLowerCase()) || job.command.toLowerCase().includes(search.toLowerCase());
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
      {/* Toolbar: search + filter + Add job + view toggle */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        {/* violations-suppress: react/no-raw-input search bar - FieldText requires label prop, this is a labelless search input */}
        <input type="text" placeholder="Search jobs..." value={search} onChange={e => setSearch(e.target.value)} className={SEARCH_CLS} />
        <div className="flex items-center gap-2 flex-wrap">
          {filterLabels.map(({ key, label }) => (
            // violations-suppress: react/no-raw-button filter chip toggle - active/inactive state not supported by Button
            <button key={key} onClick={() => setFilter(key)} className={filter === key ? CHIP_ACTIVE : CHIP_INACTIVE}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {onExport && (
            // violations-suppress: react/no-raw-button icon action - no Button variant for compact secondary actions
            <button onClick={onExport} className="px-3 py-2 text-sm border border-border rounded-md text-muted hover:bg-muted-bg" title="Export jobs as JSON">
              Export
            </button>
          )}
          {onImport && (
            // violations-suppress: react/no-raw-button icon action - no Button variant for compact secondary actions
            <button onClick={onImport} className="px-3 py-2 text-sm border border-border rounded-md text-muted hover:bg-muted-bg" title="Import jobs from JSON">
              Import
            </button>
          )}
          {/* violations-suppress: react/no-raw-button navigation button - Button component does not support href/onClick+navigate pattern */}
          <button
            onClick={() => navigate('/jobs/new')}
            className={ADD_BTN_CLS}
          >
            Add job
          </button>
          {/* violations-suppress: react/no-raw-button icon-only toggle button - Button component requires a label prop and does not support icon-only mode */}
          <button
            onClick={toggleView}
            aria-label={viewMode === 'grid' ? 'List view' : 'Grid view'}
            title={viewMode === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
            className="p-2 rounded border border-border bg-muted-bg hover:opacity-80"
          >
            {viewMode === 'grid' ? <LayoutList size={16} /> : <LayoutGrid size={16} />}
          </button>
        </div>
      </div>

      {items.length === 0 && <p className="text-muted text-center py-12">No jobs registered yet.</p>}
      {items.length > 0 && visible.length === 0 && <p className="text-muted text-center py-12">No jobs match the current filter.</p>}

      {viewMode === 'grid' ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map(({ job, runHistory }) => (
            <JobCard key={job.id} job={job} runHistory={runHistory}
              onClick={() => navigate(`/jobs/${job.id}`)}
              onTrigger={handleTrigger} onToggle={handleToggle} />
          ))}
        </div>
      ) : (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="text-left text-muted border-b">
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
                <tr key={job.id} className="border-b hover:bg-muted-bg cursor-pointer" onClick={() => navigate(`/jobs/${job.id}`)}>
                  <td className="py-2 pr-4 text-content font-medium">{job.label}</td>
                  <td className="py-2 pr-4 text-muted">{job.type}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-muted">{job.schedule ?? `${job.delaySeconds ?? 0}s`}</td>
                  <td className="py-2 pr-4"><JobStatusBadge exitCode={last?.exitCode ?? null} running={last?.exitCode === null && runHistory.length > 0} /></td>
                  <td className="py-2 pr-4 text-xs text-muted">
                    {last ? relativeTime(last.startedAt) : 'Never'}
                  </td>
                  <td className="py-2">
                    {/* violations-suppress: react/no-raw-button inline table action button - no accessible Button variant fits this compact cell context */}
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
