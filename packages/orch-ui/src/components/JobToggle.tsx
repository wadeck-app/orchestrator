import React, { useState } from 'react';
import { Switch, Tooltip } from '@wadeck-app/dsl-ui';
import type { Job } from '../types.js';

export interface JobToggleProps { job: Job; }

/**
 * Enable/disable switch that calls the daemon itself.
 *
 * Differs from EnableToggle only in owning the request rather than taking an onToggle. The
 * switch is dsl-ui's; both files used to carry the same 190-character peer-modifier class
 * string, copied verbatim.
 *
 * @registryCategory composite
 * @registryTags toggle enable disable job
 */
export function JobToggle({ job }: JobToggleProps): React.ReactElement {
  const [loading, setLoading] = useState(false);
  const [optimistic, setOptimistic] = useState(job.enabled);

  const handleChange = async (next: boolean) => {
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

  const hint = optimistic ? 'Enabled - click to disable' : 'Disabled - click to enable';

  return (
    // The span carries stopPropagation: this can sit inside a clickable job card.
    <span onClick={e => e.stopPropagation()}>
      <Tooltip content={hint}>
        <Switch checked={optimistic} onChange={handleChange} disabled={loading} size="sm" />
      </Tooltip>
    </span>
  );
}
