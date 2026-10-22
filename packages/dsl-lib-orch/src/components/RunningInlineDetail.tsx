import React, { useState, useEffect } from 'react';
import { Square } from 'lucide-react';
import { isJobRunning, liveOrLatestRun, type Job, type RuntimeEntry } from '../types.js';
import { postTrigger, readErrorSentence } from '../trigger-job.js';
import { TriggerButton } from './TriggerButton.js';
import { DryRunButton } from './DryRunButton.js';
import { RestartButton } from './RestartButton.js';
import { JobToggle } from './JobToggle.js';
import { ButtonAction, ButtonCancel, ButtonLink } from '@wadeck-app/dsl-ui';
import { TYPE_BADGE_BASE, TYPE_COLORS } from './JobCard.js';
import { useConfirm } from '../use-confirm.js';
import { formatElapsed } from '../relative-time.js';
import { appPath, getApiBase } from '../runtime-config.js';

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
  /**
   * Fired once a Run now this component ran itself has settled, started or refused. The component
   * posts the trigger itself because a page-owned brain cannot see a refusal (a 200 body, not a
   * status); this lets the page reload.
   */
  onAfterTrigger?: () => void;
  onDelete?: () => void;
  onDryRun?: () => void;
  /** Fired, after the confirmation, instead of the component posting the restart itself. Only a running job with no timeout offers Restart. */
  onRestart?: () => void;
  onViewLogs?: () => void;
  onEdit?: () => void;
  onKill?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job detail running inline design-c
 */
export function RunningInlineDetail({ job, jobId, runHistory, onAfterTrigger, onKill, onDelete, onDryRun, onRestart, onViewLogs, onEdit }: RunningInlineDetailProps): React.ReactElement | null {
  const [, setTick] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [killing, setKilling] = useState(false);
  const { ask, dialog } = useConfirm();
  const [justKilled, setJustKilled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The instance that is alive, not a newer one that already ended.
  const currentRun = liveOrLatestRun(runHistory);
  const isRunning = isJobRunning(runHistory) && !justKilled;

  // A new run must clear the optimistic hide, otherwise it stays hidden forever.
  useEffect(() => { setJustKilled(false); }, [currentRun?.pid]);

  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const handleTrigger = async (id: string, opts?: { force: true }) => {
    try {
      return await postTrigger(id, opts);
    } finally {
      onAfterTrigger?.();
    }
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
      const res = await fetch(`${getApiBase()}/api/jobs/${jobId}/kill`, { method: 'POST' });
      if (!res.ok) {
        setError(await readErrorSentence(res, `Failed to kill job (HTTP ${res.status})`));
        return;
      }
      setJustKilled(true);
    } finally { setKilling(false); }
  };

  const handleDelete = () => {
    if (onDelete) { onDelete(); return; }
    if (!confirmDelete) { setConfirmDelete(true); return; }
    void fetch(`${getApiBase()}/api/jobs/${jobId}`, { method: 'DELETE' }).then(() => { window.location.href = appPath('/'); });
  };

  // After every hook: the page mounts this before its data arrives, and a return ahead of the hooks
  // makes the first render call none and the next call all of them.
  if (!job) {
    return null;
  }

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
            <RestartButton job={job} jobId={jobId} running={isRunning} onRestart={onRestart} />
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
        <DryRunButton job={job} jobId={jobId} onDryRun={onDryRun} />
        {onViewLogs
          ? <ButtonAction label="View logs" variant="secondary" onClick={onViewLogs} />
          : <ButtonLink to={appPath(`/jobs/${jobId}/logs`)} label="View logs" variant="neutral" />}
        {onEdit
          ? <ButtonAction label="Edit" variant="secondary" onClick={onEdit} />
          : <ButtonLink to={appPath(`/jobs/${jobId}/edit`)} label="Edit" variant="neutral" />}
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
