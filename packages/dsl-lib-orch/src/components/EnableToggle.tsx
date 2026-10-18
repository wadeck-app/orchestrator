import React, { useState } from 'react';
import { Switch, Tooltip } from '@wadeck-app/dsl-ui';
import type { Job } from '../types.js';

export interface EnableToggleProps {
  job: Job;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
}

/**
 * Enable/disable switch for a job, with optimistic state and rollback.
 *
 * The switch itself is dsl-ui's. This used to hand-roll it as an sr-only checkbox plus a
 * 190-character peer-modifier class string, duplicated verbatim in JobToggle. Switch's `sm`
 * size is the same w-9 h-5 geometry, is Radix-backed so it is keyboard operable and focus
 * visible, and reports role="switch" rather than role="checkbox" - the correct role for an
 * on/off control.
 *
 * @registryCategory composite
 * @registryTags toggle enable disable
 */
export function EnableToggle({ job, onToggle }: EnableToggleProps): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [optimisticEnabled, setOptimisticEnabled] = useState(job.enabled);

  const handleChange = async (next: boolean) => {
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

  const hint = optimisticEnabled ? 'Enabled - click to disable' : 'Disabled - click to enable';

  return (
    // The span carries stopPropagation: this sits inside a clickable job card, and neither
    // Switch nor Tooltip takes an event handler to stop the bubble with.
    <span onClick={e => e.stopPropagation()}>
      <Tooltip content={hint}>
        <Switch
          checked={optimisticEnabled}
          onChange={handleChange}
          disabled={loading}
          size="sm"
        />
      </Tooltip>
    </span>
  );
}
