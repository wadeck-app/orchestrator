import React from 'react';
import { FilterChips } from '@wadeck-app/dsl-ui';

/**
 * `past-once` is the odd one out: every other value narrows by type or by outcome within the jobs that
 * still have work ahead of them, and this one switches to the ones that do not. A spent `once` job is
 * excluded from all the others, so "Once" means "still to fire" and stays a useful view.
 */
export type JobFilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed' | 'past-once';

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
  // Last, because it is the only one that looks backwards. Adjacent to "Once" so the pair reads as
  // "still to fire" / "already fired".
  { value: 'past-once', label: 'Past once' },
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
