import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Job, RuntimeEntry } from '../types.js';
import { JobCard } from './JobCard.js';
import { Button } from './Button.js';
import { JobSearchBar } from './JobSearchBar.js';

// @formatter:off
const CHIP_ACTIVE   = 'px-3 py-1 rounded-full text-sm font-medium bg-primary text-on-primary';
const CHIP_INACTIVE = 'px-3 py-1 rounded-full text-sm font-medium bg-muted-bg text-muted border border-border hover:bg-border';
// @formatter:on

export interface JobWithHistory {
  job: Job;
  runHistory: RuntimeEntry[];
}

type FilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed';

export interface JobListSectionProps {
  jobs?: JobWithHistory[];
}

/**
 * @registryCategory composite
 * @registryTags jobs list grid
 */
export function JobListSection({ jobs }: JobListSectionProps): React.ReactElement {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');
  const [mutationError, setMutationError] = useState<string | null>(null);

  const handleTrigger = useCallback(async (id: string) => {
    setMutationError(null);
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error: string }).error ?? res.statusText);
    }
  }, []);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    setMutationError(null);
    const action = enabled ? 'enable' : 'disable';
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const message = (err as { error: string }).error ?? res.statusText;
      setMutationError(message);
      throw new Error(message);
    }
  }, []);

  if (!jobs) {
    return (
      <div className="flex justify-center py-12">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const filterLabels: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'cron', label: 'Cron' },
    { key: 'startup', label: 'Startup' },
    { key: 'once', label: 'Once' },
    { key: 'failed', label: 'Failed' },
  ];

  const filtered = jobs.filter(({ job, runHistory }) => {
    const lastRun = runHistory[0] ?? null;
    const matchSearch =
      !search ||
      job.label.toLowerCase().includes(search.toLowerCase()) ||
      job.command.toLowerCase().includes(search.toLowerCase());
    const matchFilter =
      filter === 'all' ||
      (filter === 'cron' && job.type === 'cron') ||
      (filter === 'startup' && job.type === 'startup') ||
      (filter === 'once' && job.type === 'once') ||
      (filter === 'failed' && lastRun !== null && lastRun.exitCode !== 0);
    return matchSearch && matchFilter;
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-content">Orchestrator Dashboard</h1>
        <Button label="Add job" onClick={() => navigate('/jobs/new')} />
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <JobSearchBar value={search} onChange={setSearch} />
        <div className="flex gap-2 flex-wrap">
          {filterLabels.map(({ key, label }) => (
            // violations-suppress: react/no-raw-button filter chip toggle - active/inactive state not supported by Button
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={filter === key ? CHIP_ACTIVE : CHIP_INACTIVE}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {mutationError && (
        <div className="mb-4 bg-danger-subtle border border-danger rounded-md p-3">
          <p className="text-danger text-sm">{mutationError}</p>
        </div>
      )}

      {jobs.length === 0 && (
        <p className="text-muted text-center py-12">No jobs registered yet.</p>
      )}

      {jobs.length > 0 && filtered.length === 0 && (
        <p className="text-muted text-center py-12">No jobs match the current filter.</p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map(({ job, runHistory }) => (
          <JobCard
            key={job.id}
            job={job}
            runHistory={runHistory}
            onClick={() => navigate(`/jobs/${job.id}`)}
            onTrigger={handleTrigger}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </div>
  );
}
