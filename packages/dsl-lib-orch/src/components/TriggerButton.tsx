import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Play, XCircle } from 'lucide-react';
import { ButtonAction } from '@wadeck-app/dsl-ui';
import { getErrorMessage, isTriggerRefused, type TriggerRefused } from '../types.js';

export interface TriggerButtonProps {
  jobId: string;
  /**
   * Resolves with a `TriggerRefused` when the job is at its limit. `force` asks to start another
   * instance anyway; it is only passed on the click that follows a refusal.
   */
  onTrigger: (id: string, opts?: { force: true }) => Promise<void | TriggerRefused>;
  feedbackDurationMs?: number;
  /**
   * Compact hosts pass 'sm'. A card footer sits beside a small link, a detail page's action
   * row beside md buttons, and this button has to match whichever it is standing in.
   */
  size?: 'sm' | 'md';
}

type Status = 'idle' | 'loading' | 'success' | 'error' | 'refused';

const FEEDBACK_DURATION_MS = 3_000;

// Only the colour changes with status. Padding, font size and the spinner come from the
// design system button: this used to hand-roll px-3 py-1.5 text-xs, which made it 8px
// shorter than the ButtonAction buttons it sits beside in every job card and detail view.
const VARIANT_BY_STATUS = {
  idle:    'primary',
  loading: 'primary',
  success: 'success',
  error:   'danger',
  // Neither a success nor a failure, so neither colour.
  refused: 'secondary',
} as const satisfies Record<Status, 'primary' | 'secondary' | 'success' | 'danger'>;

// ButtonAction drops the icon while loading, where the spinner takes that slot.
const CONTENT_BY_STATUS: Record<Status, { icon?: React.ReactNode; label: string }> = {
  idle:    { icon: <Play size={14} />,        label: 'Run now' },
  loading: {                                  label: 'Running...' },
  success: { icon: <CheckCircle size={14} />, label: 'Triggered' },
  error:   { icon: <XCircle size={14} />,     label: 'Error' },
  // The label is built from the refusal, which carries the count; see the render.
  refused: { icon: <Play size={14} />,        label: 'Already running' },
};

/**
 * @registryCategory atomic
 * @registryTags button trigger run
 */
export function TriggerButton({ jobId, onTrigger, feedbackDurationMs = FEEDBACK_DURATION_MS, size = 'md' }: TriggerButtonProps): React.ReactElement {
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<TriggerRefused | null>(null);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The feedback timer was only cleared on the next click, never on unmount, so a click followed by
  // navigating away left it running and it called setStatus on a gone component. In a test that
  // lands after jsdom is torn down and surfaces as "window is not defined" from inside React, which
  // is what reddened CI on one platform while passing on the others.
  useEffect(() => () => {
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
  }, []);

  const handleClick = useCallback(async () => {
    if (status === 'loading') {
      return;
    }
    if (resetTimer.current) {
      clearTimeout(resetTimer.current);
    }
    // Clicking while the refusal is still showing is the answer to "run anyway?".
    const force = status === 'refused';
    setStatus('loading');
    setErrorMsg(null);
    setRefusal(null);
    try {
      const result = await onTrigger(jobId, force ? { force: true } : undefined);
      if (isTriggerRefused(result)) {
        setRefusal(result);
        setStatus('refused');
        // success:false because nothing started, refused:true so a listener can tell it from a failure.
        window.dispatchEvent(new CustomEvent('orch:job-triggered', { detail: { jobId, success: false, refused: true } }));
      } else {
        setStatus('success');
        window.dispatchEvent(new CustomEvent('orch:job-triggered', { detail: { jobId, success: true } }));
      }
    } catch (err) {
      setErrorMsg(getErrorMessage(err));
      setStatus('error');
      window.dispatchEvent(new CustomEvent('orch:job-triggered', { detail: { jobId, success: false } }));
    } finally {
      resetTimer.current = setTimeout(() => {
        setStatus('idle');
        setErrorMsg(null);
        setRefusal(null);
        resetTimer.current = null;
      }, feedbackDurationMs);
    }
  }, [jobId, onTrigger, status]);

  const { icon, label } = CONTENT_BY_STATUS[status];

  return (
    // The span carries stopPropagation, not the button: this sits inside a clickable job
    // card, and ButtonAction's onClick takes no event to stop the bubble with.
    <span onClick={e => e.stopPropagation()}>
      <ButtonAction
        onClick={handleClick}
        variant={VARIANT_BY_STATUS[status]}
        size={size}
        icon={icon}
        // Renders the spinner and disables, so no hand-rolled Loader2 or opacity is needed.
        loading={status === 'loading'}
        // The error text is the label in that state, so it needs no separate tooltip.
        label={status === 'error'
          ? (errorMsg ?? 'Error')
          : status === 'refused' && refusal
          ? `Already running (${refusal.running}/${refusal.maxConcurrency}) - run anyway?`
          : label}
      />
    </span>
  );
}
