import React, { useState } from 'react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { getErrorMessage, type Job } from '../types.js';
import { postDryRun } from '../trigger-job.js';
import { useConfirm } from '../use-confirm.js';

export interface DryRunButtonProps {
  job: Job;
  jobId: string;
  /** A page-owned handler (a DSL $output). Without it the button posts the dry run itself and reports the answer. */
  onDryRun?: () => void;
}

/**
 * "Dry run" for a job that declares dryRunSupported: runs its command with `--dry-run` appended.
 *
 * Renders nothing for any other job, so the detail variants can mount it unconditionally. Like Run now it
 * posts by itself when no page handler is given, because a page-owned brain cannot show the answer: the
 * daemon says in the body whether it started, finished or refused.
 *
 * Deliberately unannotated for the component registry: an internal building block, not a DSL node type.
 */
export function DryRunButton({ job, jobId, onDryRun }: DryRunButtonProps): React.ReactElement | null {
  const [running, setRunning] = useState(false);
  const { notify, dialog } = useConfirm();

  if (job.dryRunSupported !== true) {
    return null;
  }

  const handleClick = async (): Promise<void> => {
    if (onDryRun) {
      onDryRun();
      return;
    }
    setRunning(true);
    try {
      const result = await postDryRun(jobId);
      notify({
        title: 'Dry run',
        message: 'pid' in result
          ? `Started (pid ${result.pid ?? 'unknown'}). Its output is in the job's logs.`
          : `Finished with exit code ${result.exitCode ?? 'none (killed)'}. Its output is in the job's logs.`,
      });
    } catch (err) {
      notify({ title: 'Dry run failed', message: getErrorMessage(err) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <>
      <ButtonAction label="Dry run" variant="secondary" onClick={() => { void handleClick(); }} loading={running} />
      {dialog}
    </>
  );
}
