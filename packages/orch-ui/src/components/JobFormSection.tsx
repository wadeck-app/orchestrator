import React, { useEffect, useState } from 'react';
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
  const [resolved, setResolved] = useState<Partial<Job> | undefined>(initial?.job);
  const [loading, setLoading] = useState(isEdit && !initial);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !jobId || initial) return;
    setLoading(true);
    fetch(`/api/jobs/${jobId}`)
      .then((r) => r.ok ? r.json() : r.json().then((e: unknown) => Promise.reject(new Error((e as { error?: string }).error ?? 'Not found'))))
      .then((data: { job: Job }) => { setResolved(data.job); setLoading(false); })
      .catch((e: unknown) => { setError(getErrorMessage(e)); setLoading(false); });
  }, [isEdit, jobId, initial]);

  const handleSubmit = async (data: Partial<Job>) => {
    if (onSubmitProp) { await onSubmitProp(data); return; }
    const res = isEdit && jobId
      ? await fetch(`/api/jobs/${jobId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      : await fetch('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error((err as { error: string }).error ?? res.statusText);
    }
    const result: Job = await res.json();
    if (onSuccess) { onSuccess(result.id); } else { navigate(`/jobs/${result.id}`); }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-bold text-content mb-6">
        {isEdit ? 'Edit job' : 'Add job'}
      </h1>
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      <JobForm
        initial={resolved}
        onSubmit={handleSubmit}
        onCancel={() => onCancel ? onCancel() : navigate(-1)}
      />
    </div>
  );
}
