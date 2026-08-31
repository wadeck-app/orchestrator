import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { EnableToggle, TriggerButton, RunHistory } from '@wadeck-app/orch-ui';
import { api, type JobWithState } from '../api.js';

export function JobDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<JobWithState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.getJob(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-red-600">{error ?? 'Job not found.'}</p>
        <Link to="/" className="text-blue-600 underline text-sm mt-2 inline-block">Back to list</Link>
      </div>
    );
  }

  const { job, lastRun } = data;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.deleteJob(job.id);
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <Link to="/" className="text-sm text-blue-600 hover:underline mb-4 inline-block">&larr; Back</Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{job.label}</h1>
          <span className="inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
            {job.type}
          </span>
        </div>
        <div className="flex gap-2">
          <EnableToggle
            job={job}
            onToggle={async (jobId, enabled) => {
              await (enabled ? api.enableJob(jobId) : api.disableJob(jobId));
              await load();
            }}
          />
          <TriggerButton jobId={job.id} onTrigger={api.triggerJob} />
        </div>
      </div>

      <div className="bg-white rounded-lg border border-gray-200 p-4 mb-4 space-y-3">
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Command</span>
          <p className="mt-1 font-mono text-sm text-gray-800 break-all">{job.command}</p>
        </div>
        {job.cwd && (
          <div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Working directory</span>
            <p className="mt-1 font-mono text-sm text-gray-800">{job.cwd}</p>
          </div>
        )}
        {job.type === 'cron' && job.schedule && (
          <div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Schedule</span>
            <p className="mt-1 font-mono text-sm text-gray-800">{job.schedule}</p>
          </div>
        )}
        {job.type === 'startup' && job.delaySeconds !== undefined && (
          <div>
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Startup delay</span>
            <p className="mt-1 text-sm text-gray-800">{job.delaySeconds}s</p>
          </div>
        )}
        <div>
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Trigger mode</span>
          <p className="mt-1 text-sm text-gray-800">{job.triggerMode}</p>
        </div>
      </div>

      <div className="mb-6">
        <h2 className="text-sm font-medium text-gray-700 mb-2">Last run</h2>
        <RunHistory lastRun={lastRun} />
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link
          to={`/jobs/${job.id}/logs`}
          className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700"
        >
          View logs
        </Link>
        <Link
          to={`/jobs/${job.id}/edit`}
          className="px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded-md text-gray-700"
        >
          Edit
        </Link>
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-3 py-2 text-sm bg-red-50 hover:bg-red-100 text-red-700 rounded-md"
          >
            Delete
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Are you sure?</span>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="px-3 py-1.5 text-sm bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Yes, delete'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              className="px-3 py-1.5 text-sm bg-gray-200 rounded-md hover:bg-gray-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>

      {error && <p className="mt-4 text-red-600 text-sm">{error}</p>}
    </div>
  );
}
