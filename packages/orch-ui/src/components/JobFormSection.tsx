import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { Job } from '../types.js';
import { getErrorMessage } from '../types.js';
import { JobForm } from './JobForm.js';

export interface JobFormSectionProps {
  jobId?: string;
  initial?: { job: Job };
  /** DSL $outputs callbacks — injected via registry-overrides */
  onSubmit?: (data: Partial<Job>) => Promise<void>;
  onSuccess?: (id: string) => void;
  onCancel?: () => void;
}

/**
 * @registryCategory composite
 * @registryTags job form create edit
 */
export function JobFormSection({ jobId, initial, onSubmit: onSubmitProp, onSuccess, onCancel }: JobFormSectionProps): React.ReactElement {
  const navigate = useNavigate();
  const isEdit = Boolean(jobId);
  // Data for edit mode comes from initial prop (injected via $sources.jobData in YAML).
  // No internal fetch — that is the DSL data layer's responsibility.
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (data: Partial<Job>) => {
    setError(null);
    try {
      if (onSubmitProp) {
        await onSubmitProp(data);
        return;
      }
      const res = isEdit && jobId
        ? await fetch(`/api/jobs/${jobId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        : await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error: string }).error ?? res.statusText);
      }
      const result: Job = await res.json();
      if (onSuccess) { onSuccess(result.id); } else { navigate(`/jobs/${result.id}`); }
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
        onCancel={() => onCancel ? onCancel() : navigate(-1)}
      />
    </div>
  );
}
