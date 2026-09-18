import React from 'react';
import type { Job, JobFormPayload } from '../types.js';
import { getErrorMessage } from '../types.js';
import { JobForm } from './JobForm.js';

export interface JobFormSectionProps {
  jobId?: string;
  initial?: { job: Job };
  /**
   * DSL $outputs callbacks -- injected via registry-overrides. Takes the payload, not Partial<Job>:
   * the whole object becomes the PUT body, and `unset` is what carries the fields the user emptied.
   */
  onSubmit?: (data: JobFormPayload) => void | Promise<void>;
  onCancel?: () => void;
  /**
   * Bound to `$brains.<id>.$pending` in the YAML page.
   *
   * The brain owns the request, so this component cannot tell when the save finishes - awaiting
   * `onSubmit` returns as soon as the event is published. Without this the Save button looked idle
   * for the whole duration of the save.
   */
  saving?: boolean;
}

/**
 * @registryCategory composite
 * @registryTags job form create edit
 */
export function JobFormSection({ jobId, initial, onSubmit: onSubmitProp, onCancel, saving }: JobFormSectionProps): React.ReactElement {
  const isEdit = Boolean(jobId);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (data: JobFormPayload) => {
    if (!onSubmitProp) {
      setError('[JobFormSection] onSubmit is not wired -- add $brains.$http.post to the YAML page');
      console.error('[JobFormSection] onSubmit prop is required -- wire this component via YAML $brains');
      return;
    }
    setError(null);
    try {
      await onSubmitProp(data);
    } catch (e) {
      setError(getErrorMessage(e));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-bold text-content mb-6">
        {isEdit ? 'Edit job' : 'Add job'}
      </h1>
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      <JobForm
        key={initial?.job?.id ?? 'new'}
        initial={initial?.job}
        onSubmit={handleSubmit}
        onCancel={onCancel ?? (() => window.history.back())}
        busy={saving}
      />
    </div>
  );
}
