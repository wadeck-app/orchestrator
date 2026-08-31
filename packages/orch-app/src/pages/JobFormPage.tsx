import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { JobForm } from '@wadeck-app/orch-ui';
import type { Job } from '../types.js';
import { api } from '../api.js';

export function JobFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(id);
  const [initial, setInitial] = useState<Partial<Job> | undefined>(undefined);
  const [loading, setLoading] = useState(isEdit);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isEdit || !id) return;
    api.getJob(id)
      .then(({ job }) => { setInitial(job); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [id, isEdit]);

  const handleSubmit = async (data: Partial<Job>) => {
    if (isEdit && id) {
      const updated = await api.editJob(id, data);
      navigate(`/jobs/${updated.id}`);
    } else {
      const created = await api.addJob(data);
      navigate(`/jobs/${created.id}`);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {isEdit ? 'Edit job' : 'Add job'}
      </h1>
      {error && <p className="text-red-600 text-sm mb-4">{error}</p>}
      <JobForm
        initial={initial}
        onSubmit={handleSubmit}
        onCancel={() => navigate(-1)}
      />
    </div>
  );
}
