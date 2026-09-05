import React, { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EnableToggle } from './EnableToggle.js';
import { TriggerButton } from './TriggerButton.js';
import { RunHistory } from './RunHistory.js';
import { Button } from './Button.js';
import type { JobWithHistory } from './JobListSection.js';
import { getErrorMessage } from '../types.js';
import { ArrowLeft } from 'lucide-react';

interface Props {
  data?: JobWithHistory | null;
  jobId: string;
}

// @formatter:off
const TYPE_BADGE_CLS = 'inline-block mt-1 px-2 py-0.5 text-xs font-medium rounded-full bg-muted-bg text-muted';
const LINK_BTN_CLS  = 'px-3 py-2 text-sm bg-muted-bg hover:opacity-80 rounded-md text-content border border-border';
// @formatter:on

/**
 * @registryCategory composite
 * @registryTags job detail view
 */
export function JobDetailSection({ data, jobId }: Props): React.ReactElement {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mutError, setMutError] = useState<string | null>(null);

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    const action = enabled ? 'enable' : 'disable';
    const res = await fetch(`/api/jobs/${id}/${action}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error: string }).error ?? res.statusText);
    }
  }, []);

  const handleTrigger = useCallback(async (id: string) => {
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error: string }).error ?? res.statusText);
    }
  }, []);

  const handleDelete = async () => {
    setDeleting(true);
    setMutError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error: string }).error ?? res.statusText);
      }
      navigate('/');
    } catch (e) {
      setMutError(getErrorMessage(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  if (!data) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const { job, runHistory } = data;

  return (
    <div>
      <Link to="/" className="inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4"><ArrowLeft size={14} />Back</Link>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-content">{job.label}</h1>
          <span className={TYPE_BADGE_CLS}>
            {job.type}
          </span>
        </div>
        <div className="flex gap-2">
          <EnableToggle job={job} onToggle={handleToggle} />
          <TriggerButton jobId={job.id} onTrigger={handleTrigger} />
        </div>
      </div>

      <div className="bg-surface rounded-lg border border-border p-4 mb-4 space-y-3">
        <div>
          <span className="text-xs font-medium text-muted uppercase tracking-wide">Command</span>
          <p className="mt-1 font-mono text-sm text-content break-all">{job.command}</p>
        </div>
        {job.cwd && (
          <div>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">Working directory</span>
            <p className="mt-1 font-mono text-sm text-content">{job.cwd}</p>
          </div>
        )}
        {job.type === 'cron' && job.schedule && (
          <div>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">Schedule</span>
            <p className="mt-1 font-mono text-sm text-content">{job.schedule}</p>
          </div>
        )}
        {job.type === 'startup' && job.delaySeconds !== undefined && (
          <div>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">Startup delay</span>
            <p className="mt-1 text-sm text-content">{job.delaySeconds}s</p>
          </div>
        )}
        <div>
          <span className="text-xs font-medium text-muted uppercase tracking-wide">Trigger mode</span>
          <p className="mt-1 text-sm text-content">{job.triggerMode}</p>
        </div>
        {job.missedFiring && (
          <div>
            <span className="text-xs font-medium text-muted uppercase tracking-wide">Missed firing</span>
            <p className="mt-1 text-sm text-content">{job.missedFiring}</p>
          </div>
        )}
      </div>

      <div className="mb-6">
        <h2 className="text-sm font-medium text-content mb-2">Run history</h2>
        <RunHistory entries={runHistory} />
      </div>

      <div className="flex gap-3 flex-wrap">
        <Link
          to={`/jobs/${job.id}/logs`}
          className={LINK_BTN_CLS}
        >
          View logs
        </Link>
        <Link
          to={`/jobs/${job.id}/edit`}
          className={LINK_BTN_CLS}
        >
          Edit
        </Link>
        {!confirmDelete ? (
          <Button label="Delete" variant="danger" onClick={() => setConfirmDelete(true)} />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-content">Are you sure?</span>
            <Button label={deleting ? 'Deleting...' : 'Yes, delete'} variant="danger" onClick={handleDelete} disabled={deleting} loading={deleting} />
            <Button label="Cancel" variant="secondary" onClick={() => setConfirmDelete(false)} />
          </div>
        )}
      </div>

      {mutError && <p className="mt-4 text-danger text-sm">{mutError}</p>}
    </div>
  );
}
