import React, { useState, useEffect } from 'react';
import { Square } from 'lucide-react';
import { isRunActive, latestRun, type Job, type RuntimeEntry } from '../types.js';
import { TriggerButton } from './TriggerButton.js';
import { JobToggle } from './JobToggle.js';
import { ButtonAction, ButtonCancel, ButtonLink } from '@wadeck-app/dsl-ui';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';
import { useConfirm } from '../use-confirm.js';
import { formatElapsed } from '../relative-time.js';

// @formatter:off
// violations-suppress: tailwind/no-raw-color-class amber running badge -- no semantic token for running/info state
const RUNNING_BADGE = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
// violations-suppress: tailwind/no-raw-color-class kill button uses danger color blend -- no semantic hover token
const KILL_BTN_CLS  = 'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-danger/10 text-danger border border-danger/30 hover:bg-danger hover:text-white transition-colors';
// @formatter:on

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
  if (!job) {
    return null;
  }
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);
  const { ask, dialog } = useConfirm();
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

  // Asks, then kills. The gate used to be a native confirm(), which blocks the page and cannot be
  // styled -- on a kill prompt that is exactly when the reader should be able to tell they are still
  // in the dashboard. See useConfirm.
  const handleKill = (): void => {
    const pid = currentRun?.pid;
    ask({
      title: 'Kill this process?',
      message: pid != null ? `PID ${pid}. The job stops immediately.` : 'The job stops immediately.',
      confirmLabel: 'Kill',
      onConfirm: () => { void killNow(); },
    });
  };

  const killNow = async (): Promise<void> => {
    setKilling(true);
    try {
      if (onKill) {
        // The page owns the kill, so the outcome is not ours to claim. See the long note in
        // RunningBannerDetail: `onKill` never rejects, so the old await fell through to setJustKilled
        // and a refused kill looked exactly like a successful one.
        onKill();
        return;
      }
      const res = await fetch(`/api/jobs/${jobId}/kill`, { method: 'POST' });
      if (!res.ok) {
        const e = await res.json().catch(() => ({})) as { error?: string };
        setError(e.error ?? `Failed to kill job (HTTP ${res.status})`);
        return;
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
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className={typeBadgeCls}>{job.type}</span>
        <JobToggle job={job} />
        {isRunning && currentRun ? (
          <>
            <span className={RUNNING_BADGE}>
              {/* violations-suppress: tailwind/no-raw-color-class amber pulse dot */}
              <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
              Running &middot; {formatElapsed(currentRun.startedAt, Date.now())}
              {currentRun.pid != null && <span className="opacity-70">&middot; {currentRun.pid}</span>}
            </span>
            {/* violations-suppress: react/no-raw-button pill-style kill button -- Button component cannot render this shape */}
            <button onClick={() => { void handleKill(); }} disabled={killing} className={KILL_BTN_CLS}>
              <Square size={10} />
              {killing ? 'Killing...' : 'Kill'}
            </button>
          </>
        ) : (
          <TriggerButton jobId={jobId} onTrigger={handleTrigger} />
        )}
        <span className="w-px h-5 bg-border mx-1" />
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
      {dialog}
    </div>
  );
}
