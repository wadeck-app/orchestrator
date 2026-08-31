import React, { useState } from 'react';
import type { Job } from '../types.js';

interface Props {
  job: Job;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}

export function EnableToggle({ job, onToggle }: Props): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState(job.enabled);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const next = e.target.checked;
    setOptimisticEnabled(next);
    setLoading(true);
    try {
      await onToggle(job.id, next);
    } catch {
      setOptimisticEnabled(!next);
    } finally {
      setLoading(false);
    }
  };

  return (
    <label
      className="relative inline-flex items-center cursor-pointer"
      onClick={(e) => e.stopPropagation()}
      title={optimisticEnabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
    >
      <input
        type="checkbox"
        className="sr-only peer"
        checked={optimisticEnabled}
        onChange={handleChange}
        disabled={loading}
      />
      <div className="w-9 h-5 bg-gray-300 rounded-full peer peer-checked:bg-blue-600 peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
    </label>
  );
}
