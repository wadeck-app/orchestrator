import React from 'react';
import type { Job } from '../types.js';
import { getErrorMessage } from '../types.js';
import { JobForm } from './JobForm.js';

export interface JobFormSectionProps {
  jobId?: string;
  initial?: { job: Job };
  /** DSL $outputs callbacks — injected via registry-overrides */
  onSubmit?: (data: Partial<Job>) => void | Promise<void>;
  onCancel?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job form create edit
 */
export function JobFormSection({ jobId, initial, onSubmit: onSubmitProp, onCancel }: JobFormSectionProps): React.ReactElement {
  const isEdit = Boolean(jobId);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (data: Partial<Job>) => {
    if (!onSubmitProp) {
      setError('[JobFormSection] onSubmit is not wired — add $brains.$http.post to the YAML page');
      console.error('[JobFormSection] onSubmit prop is required — wire this component via YAML $brains');
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
        initial={initial?.job}
        onSubmit={handleSubmit}
        onCancel={onCancel ?? (() => window.history.back())}
      />
    </div>
  );
}
