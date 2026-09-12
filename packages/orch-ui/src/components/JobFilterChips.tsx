import React from 'react';
import { ChipButton } from '@wadeck-app/dsl-ui';

export type JobFilterType = 'all' | 'cron' | 'startup' | 'once' | 'failed';

export interface JobFilterChipsProps {
  selected?: JobFilterType;
  onChange?: (f: JobFilterType) => void;
}

const FILTERS: { key: JobFilterType; label: string }[] = [
  { key: 'all',     label: 'All' },
  { key: 'cron',    label: 'Cron' },
  { key: 'startup', label: 'Startup' },
  { key: 'once',    label: 'Once' },
  { key: 'failed',  label: 'Failed' },
];

/**
 * @registryCategory atomic
 * @registryTags filter chips jobs type
 */
export function JobFilterChips({ selected = 'all', onChange }: JobFilterChipsProps): React.ReactElement {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FILTERS.map(({ key, label }) => (
        <ChipButton key={key} active={selected === key} onClick={() => onChange?.(key)}>
          {label}
        </ChipButton>
      ))}
    </div>
  );
}
