import React, { useState } from 'react';
import type { Job } from '../types.js';

export interface EnableToggleProps {
  job: Job;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}

/**
 * @registryCategory composite
 * @registryTags toggle enable disable
 */
export function EnableToggle({ job, onToggle }: EnableToggleProps): React.ReactElement {
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
      title={optimisticEnabled ? 'Enabled - click to disable' : 'Disabled - click to enable'}
    >
      <input
        type="checkbox"
        className="sr-only peer"
        checked={optimisticEnabled}
        onChange={handleChange}
        disabled={loading}
      />
      {/*
        peer-checked:bg-* and after:bg-white are compound Tailwind peer modifiers.
        Tailwind's JIT generates these as single atomic classes - they cannot be split
        into semantic tokens without losing the peer modifier mechanism.
      */}
      {/* violations-suppress-start: tailwind/no-raw-color-class,tailwind/no-inline-classname peer-modifier classes require raw colors - semantic tokens incompatible with peer-checked: compound syntax */}
      <div className="w-9 h-5 bg-gray-300 rounded-full peer peer-checked:bg-blue-600 peer-disabled:opacity-50 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-4" />
      {/* violations-suppress-end: tailwind/no-raw-color-class,tailwind/no-inline-classname */}
    </label>
  );
}
