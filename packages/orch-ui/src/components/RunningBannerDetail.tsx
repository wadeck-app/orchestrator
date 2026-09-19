import React, { useState, useEffect } from 'react';
import { Zap } from 'lucide-react';
import { getErrorMessage, isRunActive, latestRun, type Job, type RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { ButtonAction, ButtonCancel, ButtonLink } from '@wadeck-app/dsl-ui';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';

// @formatter:off
// violations-suppress: tailwind/no-raw-color-class blue running banner -- no semantic token for info/running state
const BANNER_CLS   = 'mb-4 flex items-center gap-4 px-4 py-3 rounded-lg border-l-4 border-blue-500 bg-blue-50 dark:bg-blue-950';
// @formatter:on

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${s % 60}s`;
  }
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
  if (!job) {
    return null;
  }
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);
  const [justKilled, setJustKilled] = useState(false);

  const currentRun = latestRun(runHistory);
  const isRunning = isRunActive(currentRun) && !justKilled;

  // A new run must clear the optimistic hide, otherwise the banner stays hidden forever.
  useEffect(() => { setJustKilled(false); }, [currentRun?.pid]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const handleTrigger = async (id: string) => {
    if (onTrigger) { onTrigger(); return; }
    await fetch(`/api/jobs/${id}/trigger`, { method: 'POST' });
  };

  const handleKill = async () => {
    const pid = currentRun?.pid;
    if (!window.confirm(`Kill this process?${pid != null ? ` (PID ${pid})` : ''}`)) {
      return;
    }
    setKilling(true);
    try {
      if (onKill) {
        await (onKill as () => Promise<void>)();
      } else {
        const res = await fetch(`/api/jobs/${jobId}/kill`, { method: 'POST' });
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string };
          alert(err.error ?? `Failed to kill job (HTTP ${res.status})`);
          return;
        }
      }
      setJustKilled(true);
    } catch (err) {
      alert(`Failed to kill job: ${getErrorMessage(err)}`);
    } finally {
      setKilling(false);
    }
  };

  const handleDelete = () => {
    if (onDelete) { onDelete(); return; }
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }).then(() => { window.location.href = '/'; });
  };

  const typeBadgeCls = `${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type as keyof typeof TYPE_COLORS] ?? 'bg-tag-once-bg text-tag-once'}`;

  return (
    <div>
      {isRunning && currentRun && (
        <div className={BANNER_CLS}>
          <span className="flex items-center gap-2 flex-1 min-w-0">
            {/* violations-suppress: tailwind/no-raw-color-class blue pulse dot for running state */}
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse shrink-0" />
            <span className="font-semibold text-content">Running</span>
            <span className="text-muted text-sm">&middot;</span>
            <span className="text-sm text-content font-mono">{formatDuration(currentRun.startedAt)}</span>
            {currentRun.pid != null && (
              <>
                <span className="text-muted text-sm">&middot;</span>
                <span className="text-xs text-muted">PID {currentRun.pid}</span>
              </>
            )}
          </span>
          <ButtonAction label="Kill process" variant="danger" onClick={handleKill} disabled={killing} loading={killing} />
        </div>
      )}

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        {!isRunning && <TriggerButton jobId={jobId} onTrigger={handleTrigger} />}
        {onViewLogs
          ? <ButtonAction label="View logs" variant="secondary" onClick={onViewLogs} />
          : <ButtonLink to={`/jobs/${jobId}/logs`} label="View logs" variant="neutral" />}
        {onEdit
          ? <ButtonAction label="Edit" variant="secondary" onClick={onEdit} />
          : <ButtonLink to={`/jobs/${jobId}/edit`} label="Edit" variant="neutral" />}
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
