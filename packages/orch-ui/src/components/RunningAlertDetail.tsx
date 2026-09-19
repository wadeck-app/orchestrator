import React, { useState, useEffect } from 'react';
import { AlertTriangle, Clock } from 'lucide-react';
import { isRunActive, latestRun, type Job, type RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { ButtonAction, ButtonCancel, ButtonLink } from '@wadeck-app/dsl-ui';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';

// @formatter:off
// violations-suppress: tailwind/no-raw-color-class amber alert for running state -- no semantic token for warning/running state
const ALERT_CARD_CLS = 'mb-4 rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950 overflow-hidden';
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  // violations-suppress: ts/no-locale-date display-only time, locale-aware formatting acceptable
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export interface RunningAlertDetailProps {
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
 * @registryTags job detail running alert design-b
 */
export function RunningAlertDetail({ job, jobId, runHistory, onTrigger, onKill, onDelete, onViewLogs, onEdit }: RunningAlertDetailProps): React.ReactElement | null {
  if (!job) {
    return null;
  }
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);
  const [justKilled, setJustKilled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRun = latestRun(runHistory);
  const isRunning = isRunActive(currentRun) && !justKilled;

  // A new run must clear the optimistic hide, otherwise it stays hidden forever.
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
          const e = await res.json().catch(() => ({})) as { error?: string };
          setError(e.error ?? `Failed to kill job (HTTP ${res.status})`);
          return;
        }
      }
      setJustKilled(true);
    } finally { setKilling(false); }
  };

  const handleDelete = () => {
    if (onDelete) { onDelete(); return; }
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void fetch(`/api/jobs/${jobId}`, { method: 'DELETE' }).then(() => { window.location.href = '/'; });
  };

  const typeBadgeCls = `${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type as keyof typeof TYPE_COLORS] ?? 'bg-tag-once-bg text-tag-once'}`;

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
      </div>

      {isRunning && currentRun ? (
        <div className={ALERT_CARD_CLS}>
          <div className="flex items-center gap-3 px-4 py-3">
            {/* violations-suppress: tailwind/no-raw-color-class amber icon for alert card running state */}
            <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-content">Job is currently running</p>
              <div className="flex items-center gap-3 mt-0.5 text-xs text-muted flex-wrap">
                <span className="flex items-center gap-1">
                  <Clock size={11} />
                  {formatDuration(currentRun.startedAt)} elapsed
                </span>
                <span>&middot; started {fmtTime(currentRun.startedAt)}</span>
                {currentRun.pid != null && <span>&middot; PID {currentRun.pid}</span>}
              </div>
            </div>
            <ButtonAction label="Kill" variant="danger" onClick={handleKill} disabled={killing} loading={killing} />
          </div>
        </div>
      ) : (
        <div className="mb-4">
          <TriggerButton jobId={jobId} onTrigger={handleTrigger} />
        </div>
      )}

      <div className="flex gap-3 flex-wrap mb-4">
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
      {error && <p className="mt-2 text-danger text-sm">{error}</p>}
    </div>
  );
}
