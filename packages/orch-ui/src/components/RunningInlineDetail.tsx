import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Square } from 'lucide-react';
import type { Job, RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { Button } from './Button.js';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';

// @formatter:off
const LINK_BTN_CLS    = 'px-3 py-2 text-sm bg-muted-bg hover:opacity-80 rounded-md text-content border border-border';
const BACK_LINK_CLS   = 'inline-flex items-center gap-1 text-sm text-muted hover:text-content mb-4';
// violations-suppress: tailwind/no-raw-color-class amber running badge -- no semantic token for running/info state
const RUNNING_BADGE   = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
// violations-suppress: tailwind/no-raw-color-class kill button uses danger color blend -- no semantic hover token
const KILL_BTN_CLS    = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-danger/10 text-danger border border-danger/30 hover:bg-danger hover:text-white transition-colors';
// @formatter:on

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export interface RunningInlineDetailProps {
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
 * @registryTags job detail running inline design-c
 */
export function RunningInlineDetail({ job, jobId, runHistory, onTrigger, onKill, onDelete, onViewLogs, onEdit }: RunningInlineDetailProps): React.ReactElement | null {
  if (!job) return null;
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const handleKill = () => {
    if (onKill) { onKill(); return; }
    void fetch(`/api/jobs/${jobId}/kill`, { method: 'POST' });
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
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        {isRunning && latestRun ? (
          <>
            <span className={RUNNING_BADGE}>
              {/* violations-suppress: tailwind/no-raw-color-class amber pulse dot */}
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Running &middot; {formatDuration(latestRun.startedAt)}
              {latestRun.pid != null && <span className="opacity-70">&middot; {latestRun.pid}</span>}
            </span>
            {/* violations-suppress: react/no-raw-button pill-style kill button -- Button component cannot render this shape */}
            <button onClick={handleKill} className={KILL_BTN_CLS}>
              <Square size={10} />
              Kill
            </button>
          </>
        ) : (
          <TriggerButton jobId={jobId} onTrigger={handleTrigger} />
        )}
        <span className="w-px h-5 bg-border mx-1" />
        {onViewLogs
          ? <Button label="View logs" variant="secondary" onClick={onViewLogs} />
          : <Link to={`/jobs/${jobId}/logs`} className={LINK_BTN_CLS}>View logs</Link>}
        {onEdit
          ? <Button label="Edit" variant="secondary" onClick={onEdit} />
          : <Link to={`/jobs/${jobId}/edit`} className={LINK_BTN_CLS}>Edit</Link>}
        {!confirmDelete
          ? <Button label="Delete" variant="danger" onClick={() => setConfirmDelete(true)} />
          : <div className="flex items-center gap-2">
              <span className="text-sm text-content">Are you sure?</span>
              <Button label="Yes, delete" variant="danger" onClick={handleDelete} />
              <Button label="Cancel" variant="secondary" onClick={() => setConfirmDelete(false)} />
            </div>}
      </div>
    </div>
  );
}
