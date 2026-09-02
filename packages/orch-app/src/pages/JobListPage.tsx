import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { JobCard } from '@wadeck-app/orch-ui';
import { api, type JobWithState } from '../api.js';

type FilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed';

export function JobListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<JobWithState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterType>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await api.listJobs());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = items.filter(({ job, runHistory }) => {
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

  const filterLabels: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'cron', label: 'Cron' },
    { key: 'startup', label: 'Startup' },
    { key: 'once', label: 'Once' },
    { key: 'failed', label: 'Failed' },
  ];

  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Orchestrator Dashboard</h1>
        <button
          onClick={() => navigate('/jobs/new')}
          className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700"
        >
          Add job
        </button>
      </div>

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          placeholder="Search jobs..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex gap-2 flex-wrap">
          {filterLabels.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1 rounded-full text-sm font-medium ${
                filter === key
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-md p-4 flex items-center justify-between">
          <p className="text-red-700 text-sm">{error}</p>
          <button onClick={load} className="text-red-600 underline text-sm ml-4">
            Retry
          </button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && (
        <p className="text-gray-500 text-center py-12">
          {items.length === 0 ? 'No jobs registered yet.' : 'No jobs match the current filter.'}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {filtered.map(({ job, runHistory }) => (
          <JobCard
            key={job.id}
            job={job}
            lastRun={runHistory[0] ?? null}
            onClick={() => navigate(`/jobs/${job.id}`)}
            onTrigger={async (id) => { await api.triggerJob(id); }}
            onToggle={async (id, enabled) => {
              await (enabled ? api.enableJob(id) : api.disableJob(id));
              await load();
            }}
          />
        ))}
      </div>
    </div>
  );
}
