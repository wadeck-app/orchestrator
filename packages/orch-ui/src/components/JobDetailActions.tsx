import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { Job, RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { Button } from './Button.js';
import { getErrorMessage } from '../types.js';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';

// @formatter:off
const LINK_BTN_CLS  = 'px-3 py-2 text-sm bg-muted-bg hover:opacity-80 rounded-md text-content border border-border';
const BACK_LINK_CLS = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4';
// @formatter:on

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface JobDetailActionsProps {
  job: Job;
  jobId: string;
  runHistory?: RuntimeEntry[];
  /** DSL $outputs callbacks -- injected by the registry when $id is declared on the node */
  onTrigger?: () => void;
  onDelete?: () => void;
  onDryRun?: () => void;
  onViewLogs?: () => void;
  onEdit?: () => void;
  onKill?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job actions detail
 */
export function JobDetailActions({ job, jobId, runHistory, onTrigger, onDelete, onDryRun, onViewLogs, onEdit, onKill }: JobDetailActionsProps): React.ReactElement | null {
  if (!job) return null;
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const latestRun = runHistory?.[0] ?? null;
  const isRunning = latestRun !== null && latestRun.exitCode === null;

  // Re-render every second to update elapsed duration while running
  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const handleTrigger = async (id: string) => {
    if (onTrigger) { onTrigger(); return; }
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
  };

  const handleKill = async () => {
    if (onKill) { onKill(); return; }
    const res = await fetch(`/api/jobs/${jobId}/kill`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); setError((e as { error: string }).error ?? res.statusText); }
  };

  const handleDryRun = async () => {
    if (onDryRun) { onDryRun(); return; }
    const res = await fetch(`/api/jobs/${jobId}/dry-run`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); setError((e as { error: string }).error ?? res.statusText); }
  };

  const handleDelete = async () => {
    if (onDelete) { onDelete(); return; }
    setDeleting(true); setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
      if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
      navigate('/');
    } catch (e) { setError(getErrorMessage(e)); setDeleting(false); setConfirmDelete(false); }
  };

  const typeBadgeCls = `${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type as keyof typeof TYPE_COLORS] ?? 'bg-tag-once-bg text-tag-once'}`;

  return (
    <div>
      <Link to="/" className={BACK_LINK_CLS}><ArrowLeft size={14} />Back</Link>
      <div className="flex items-center gap-3 mb-2 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        {isRunning
          ? <Button label="Kill" variant="danger" onClick={handleKill} />
          : <TriggerButton jobId={jobId} onTrigger={handleTrigger} />}
        {isRunning && latestRun && (
          <span className="text-sm text-muted">
            {latestRun.pid != null && <span className="mr-3">PID {latestRun.pid}</span>}
            <span>{formatDuration(latestRun.startedAt)}</span>
          </span>
        )}
      </div>
      <div className="flex gap-3 flex-wrap mb-4">
        {onViewLogs
          ? <Button label="View logs" variant="secondary" onClick={onViewLogs} />
          : <Link to={`/jobs/${jobId}/logs`} className={LINK_BTN_CLS}>View logs</Link>}
        {onEdit
          ? <Button label="Edit" variant="secondary" onClick={onEdit} />
          : <Link to={`/jobs/${jobId}/edit`} className={LINK_BTN_CLS}>Edit</Link>}
        {job.dryRunSupported && (
          <Button label="Dry run" variant="secondary" onClick={handleDryRun} />
        )}
        {!confirmDelete
          ? <Button label="Delete" variant="danger" onClick={() => setConfirmDelete(true)} />
          : <div className="flex items-center gap-2">
              <span className="text-sm text-content">Are you sure?</span>
              <Button label={deleting ? 'Deleting...' : 'Yes, delete'} variant="danger" onClick={handleDelete} disabled={deleting} loading={deleting} />
              <Button label="Cancel" variant="secondary" onClick={() => setConfirmDelete(false)} />
            </div>
        }
      </div>
      {error && <p className="mt-2 text-danger text-sm">{error}</p>}
    </div>
  );
}
