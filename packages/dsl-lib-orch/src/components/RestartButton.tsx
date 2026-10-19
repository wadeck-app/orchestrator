import React, { useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { getErrorMessage, type Job } from '../types.js';
import { postRestart } from '../trigger-job.js';
import { useConfirm } from '../use-confirm.js';

export interface RestartButtonProps {
  job: Job;
  jobId: string;
  /** Whether a run of the job is alive now: starting what is not running is Run now's business. */
  running: boolean;
  /** A page-owned handler (a DSL $output). Without it the button posts the restart itself and reports the answer. */
  onRestart?: () => void;
}

/**
 * "Restart" for a running job that must stay up (timeoutSeconds 0): ends the instance, waits until it is gone, and
 * starts it again. The daemon accepts any job; the button is limited to the long-running ones because restarting a
 * five-minute batch from a button is a different decision.
 *
 * Renders nothing for any other job, so the detail variants can mount it unconditionally. Asks first, with the same
 * dialog Kill uses, and like Dry run it posts by itself when no page handler is given because the daemon's answer
 * (restarted, or refused with a reason) is in the body, which a page-owned brain cannot show.
 *
 * Deliberately unannotated for the component registry: an internal building block, not a DSL node type.
 */
export function RestartButton({ job, jobId, running, onRestart }: RestartButtonProps): React.ReactElement | null {
  const [restarting, setRestarting] = useState(false);
  const { ask, notify, dialog } = useConfirm();

  if (!running || job.timeoutSeconds !== 0) {
    return null;
  }

  const restartNow = async (): Promise<void> => {
    if (onRestart) {
      onRestart();
      return;
    }
    setRestarting(true);
    try {
      const result = await postRestart(jobId);
      if (result.started) {
        notify({
          title: 'Restarted',
          message: `${job.label ?? jobId} was restarted (new pid ${result.pid ?? 'unknown'}).`,
        });
      } else {
        notify({
          title: 'Not restarted',
          message: `${result.wasRunning ? 'The running instance was ended but the job was not started again. ' : ''}${result.reason ?? 'The daemon gave no reason.'}`,
        });
      }
    } catch (err) {
      notify({ title: 'Restart failed', message: getErrorMessage(err) });
    } finally {
      setRestarting(false);
    }
  };

  const handleClick = (): void => {
    ask({
      title: 'Restart this job?',
      message: `Restart ${job.label ?? jobId}? The running instance is ended, then started again.`,
      confirmLabel: 'Yes, restart',
      confirmVariant: 'primary',
      onConfirm: () => { void restartNow(); },
    });
  };

  return (
    <>
      <ButtonAction label="Restart" variant="secondary" onClick={handleClick} disabled={restarting} loading={restarting} />
      {dialog}
    </>
  );
}
