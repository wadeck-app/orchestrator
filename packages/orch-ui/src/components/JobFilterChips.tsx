import React from 'react';
import { FilterChips } from '@wadeck-app/dsl-ui';

export type JobFilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed';

export interface JobFilterChipsProps {
  selected?: JobFilterType;
  onChange?: (f: JobFilterType) => void;
}

// The only orchestrator-specific part: which filters a job list offers. The chip row
// itself is dsl-ui's.
const OPTIONS: { value: JobFilterType; label: string }[] = [
  { value: 'all',     label: 'All' },
  { value: 'cron',    label: 'Cron' },
  { value: 'startup', label: 'Startup' },
  { value: 'once',    label: 'Once' },
  { value: 'failed',  label: 'Failed' },
];

/**
 * Job-type filter for the job list.
 *
 * Adapts one selected type to and from the array API of dsl-ui's FilterChips, which is
 * built for multi-select. mode="single" is what makes an explicit "All" option behave as
 * a choice rather than as "nothing selected, so show everything".
 *
 * @registryCategory atomic
 * @registryTags filter chips jobs type
 */
export function JobFilterChips({ selected = 'all', onChange }: JobFilterChipsProps): React.ReactElement {
  return (
    <FilterChips
      bind="type"
      mode="single"
      options={OPTIONS}
      value={[selected]}
      onChange={values => {
        const next = values[0];
        if (next) {
          onChange?.(next as JobFilterType);
        }
      }}
    />
  );
}
