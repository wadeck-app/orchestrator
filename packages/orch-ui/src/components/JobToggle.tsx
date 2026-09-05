import React, { useState } from 'react';
import type { Job } from '../types.js';

export interface JobToggleProps { job: Job; }

/**
 * @registryCategory composite
 * @registryTags toggle enable disable job
 */
export function JobToggle({ job }: JobToggleProps): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [optimistic, setOptimistic] = useState(job.enabled);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    e.stopPropagation();
    const next = e.target.checked;
    setOptimistic(next);
    setLoading(true);
    try {
      await fetch(`/api/jobs/${job.id}/${next ? 'enable' : 'disable'}`, { method: 'POST' });
    } catch {
      setOptimistic(!next);
    } finally {
      setLoading(false);
    }
  };

  return (
    <label className="relative inline-flex items-center cursor-pointer" onClick={(e) => e.stopPropagation()}
      title={optimistic ? 'Enabled - click to disable' : 'Disabled - click to enable'}>
      <input type="checkbox" className="sr-only peer" checked={optimistic} onChange={handleChange} disabled={loading} />
      {/* violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname peer-modifier classes require raw colors - semantic tokens incompatible with peer-checked: compound syntax */}
      <div className="w-9 h-5 bg-gray-300 rounded-full peer peer-checked:bg-blue-600 peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
      {/* violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname */}
    </label>
  );
}
