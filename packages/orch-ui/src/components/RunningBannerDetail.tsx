import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Zap } from 'lucide-react';
import type { Job, RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { Button } from './Button.js';
import { ButtonAction, ButtonCancel } from '@wadeck-app/dsl-ui';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';

// @formatter:off
const LINK_BTN_CLS   = 'px-3 py-2 text-sm bg-muted-bg hover:opacity-80 rounded-md text-content border border-border';
const BACK_LINK_CLS  = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4';
// violations-suppress: tailwind/no-raw-color-class blue running banner -- no semantic token for info/running state
const BANNER_CLS     = 'mb-4 flex items-center gap-4 px-4 py-3 rounded-lg border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950';
// @formatter:on

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface RunningBannerDetailProps {
  job: Job;
  jobId: string;
  runHistory?: RuntimeEntry[];
  onTrigger?: () => void;
  onDelete?: () => void;
  onDryRun?: () => void;
  onViewLogs?: () => void;
  onEdit?: () => void;
  onKill?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job detail running banner design-a
 */
export function RunningBannerDetail({ job, jobId, runHistory, onTrigger, onKill, onDelete, onViewLogs, onEdit }: RunningBannerDetailProps): React.ReactElement | null {
  if (!job) return null;
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);

  const latestRun = runHistory?.[0] ?? null;
  const isRunning = latestRun !== null && latestRun.exitCode === null;

  useEffect(() => {
    if (!isRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const handleTrigger = async (id: string) => {
    if (onTrigger) { onTrigger(); return; }
    await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
  };

  const handleKill = async () => {
    const pid = runHistory?.[0]?.pid;
    if (!window.confirm(`Kill this process?${pid != null ? ` (PID ${pid})` : ''}`)) return;
    setKilling(true);
    try { if (onKill) await (onKill as () => Promise<void>)(); else await fetch(`/api/jobs/${jobId}/kill`, { method: 'POST' }); }
    finally { setKilling(false); }
  };

  const handleDelete = () => {
    if (onDelete) { onDelete(); return; }
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }).then(() => { window.location.href = '/'; });
  };

  const typeBadgeCls = `${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type as keyof typeof TYPE_COLORS] ?? 'bg-tag-once-bg text-tag-once'}`;

  return (
    <div>
      <Link to="/" className={BACK_LINK_CLS}><ArrowLeft size={14} />Back</Link>

      {isRunning && latestRun && (
        <div className={BANNER_CLS}>
          <span className="flex items-center gap-2 flex-1 min-w-0">
            {/* violations-suppress: tailwind/no-raw-color-class blue pulse dot for running state */}
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
            <span className="font-semibold text-content">Running</span>
            <span className="text-muted text-sm">&middot;</span>
            <span className="text-sm text-content font-mono">{formatDuration(latestRun.startedAt)}</span>
            {latestRun.pid != null && (
              <>
                <span className="text-muted text-sm">&middot;</span>
                <span className="text-xs text-muted">PID {latestRun.pid}</span>
              </>
            )}
          </span>
          <Button label={killing ? 'Killing...' : 'Kill process'} variant="danger" onClick={() => { void handleKill(); }} disabled={killing} />
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        {!isRunning && <TriggerButton jobId={jobId} onTrigger={handleTrigger} />}
        {onViewLogs
          ? <Button label="View logs" variant="secondary" onClick={onViewLogs} />
          : <Link to={`/jobs/${jobId}/logs`} className={LINK_BTN_CLS}>View logs</Link>}
        {onEdit
          ? <Button label="Edit" variant="secondary" onClick={onEdit} />
          : <Link to={`/jobs/${jobId}/edit`} className={LINK_BTN_CLS}>Edit</Link>}
        {!confirmDelete
          ? <ButtonAction label="Delete" variant="danger" onClick={() => setConfirmDelete(true)} />
          : <div className="flex items-center gap-2">
              <span className="text-sm text-content">Are you sure?</span>
              <ButtonAction label="Yes, delete" variant="danger" onClick={handleDelete} />
              <ButtonCancel onCancel={() => setConfirmDelete(false)} />
            </div>}
      </div>
    </div>
  );
}
