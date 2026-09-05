import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import type { Job } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { Button } from './Button.js';
import { getErrorMessage } from '../types.js';

// @formatter:off
const LINK_BTN_CLS  = 'px-3 py-2 text-sm bg-muted-bg hover:opacity-80 rounded-md text-content border border-border';
const BACK_LINK_CLS = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4';
// violations-suppress-start: tailwind/no-raw-color-class job-type colors have no semantic-token equivalents in the design system
const TYPE_BADGE_COLORS: Record<string, string> = {
  cron:    'bg-purple-100 text-purple-700',
  startup: 'bg-blue-100 text-blue-700',
  once:    'bg-gray-100 text-gray-600',
};
// violations-suppress-end: tailwind/no-raw-color-class
// @formatter:on

export interface JobDetailActionsProps {
  job: Job;
  jobId: string;
  /** DSL $outputs callbacks -- injected by the registry when $id is declared on the node */
  onTrigger?: () => void;
  onDelete?: () => void;
  onDryRun?: () => void;
  onViewLogs?: () => void;
  onEdit?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job actions detail
 */
export function JobDetailActions({ job, jobId, onTrigger, onDelete, onDryRun, onViewLogs, onEdit }: JobDetailActionsProps): React.ReactElement | null {
  if (!job) return null;
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleTrigger = async (id: string) => {
    if (onTrigger) { onTrigger(); return; }
    const res = await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
    if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error((e as { error: string }).error ?? res.statusText); }
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

  // violations-suppress: tailwind/no-raw-color-class job-type colors have no semantic-token equivalents
  const typeBadgeCls = `inline-block px-2 py-0.5 text-xs font-medium rounded-full ${TYPE_BADGE_COLORS[job.type] ?? 'bg-gray-100 text-gray-600'}`;

  return (
    <div>
      <Link to="/" className={BACK_LINK_CLS}><ArrowLeft size={14} />Back</Link>
      <div className="flex items-center gap-3 mb-4">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        <TriggerButton jobId={jobId} onTrigger={handleTrigger} />
      </div>
      <div className="flex gap-3 flex-wrap">
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
      {error && <p className="mt-4 text-danger text-sm">{error}</p>}
    </div>
  );
}
