import React, { useCallback, useRef, useState } from 'react';
import { CheckCircle, Loader2, Play, XCircle } from 'lucide-react';
import { getErrorMessage } from '../types.js';

export interface TriggerButtonProps {
  jobId: string;
  onTrigger: (id: string) => Promise<void>;
  feedbackDurationMs?: number;
}

type Status = 'idle' | 'loading' | 'success' | 'error';

const FEEDBACK_DURATION_MS = 3_000;

// @formatter:off
const BTN_BASE    = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded transition-all duration-150 disabled:cursor-not-allowed';
const BTN_IDLE    = `${BTN_BASE} bg-primary text-on-primary hover:bg-primary-hover`;
const BTN_LOADING = `${BTN_BASE} bg-primary text-on-primary opacity-70`;
const BTN_SUCCESS = `${BTN_BASE} bg-success text-on-primary`;
const BTN_ERROR   = `${BTN_BASE} bg-danger text-on-primary`;
// @formatter:on

/**
 * @registryCategory atomic
 * @registryTags button trigger run
 */
export function TriggerButton({ jobId, onTrigger, feedbackDurationMs = FEEDBACK_DURATION_MS }: TriggerButtonProps): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'loading') return;
    if (resetTimer.current) clearTimeout(resetTimer.current);
    setStatus('loading');
    setErrorMsg(null);
    try {
      await onTrigger(jobId);
      setStatus('success');
      window.dispatchEvent(new CustomEvent('orch:job-triggered', { detail: { jobId, success: true } }));
    } catch (err) {
      setErrorMsg(getErrorMessage(err));
      setStatus('error');
      window.dispatchEvent(new CustomEvent('orch:job-triggered', { detail: { jobId, success: false } }));
    } finally {
      resetTimer.current = setTimeout(() => {
        setStatus('idle');
        setErrorMsg(null);
        resetTimer.current = null;
      }, feedbackDurationMs);
    }
  }, [jobId, onTrigger, status]);

  const cls =
    status === 'loading' ? BTN_LOADING :
    status === 'success' ? BTN_SUCCESS :
    status === 'error'   ? BTN_ERROR :
    BTN_IDLE;

  return (
    <button
      onClick={handleClick}
      disabled={status === 'loading'}
      className={cls}
      title={status === 'error' && errorMsg ? errorMsg : undefined}
    >
      {status === 'idle'    && <><Play    size={12} />Run now</>}
      {status === 'loading' && <><Loader2 size={12} className="animate-spin" />Running...</>}
      {status === 'success' && <><CheckCircle size={12} />Triggered</>}
      {status === 'error'   && <><XCircle size={12} />{errorMsg ?? 'Error'}</>}
    </button>
  );
}
