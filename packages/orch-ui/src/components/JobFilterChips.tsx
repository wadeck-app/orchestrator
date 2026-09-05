import React from 'react';

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

// @formatter:off
const ACTIVE   = 'px-3 py-1 rounded-full text-sm font-medium bg-primary text-on-primary';
const INACTIVE = 'px-3 py-1 rounded-full text-sm font-medium bg-muted-bg text-muted border border-border hover:bg-border';
// @formatter:on

/**
 * @registryCategory atomic
 * @registryTags filter chips jobs type
 */
export function JobFilterChips({ selected = 'all', onChange }: JobFilterChipsProps): React.ReactElement {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {FILTERS.map(({ key, label }) => (
        // violations-suppress: react/no-raw-button filter chip - active/inactive state not supported by Button
        <button key={key} onClick={() => onChange?.(key)} className={selected === key ? ACTIVE : INACTIVE}>
          {label}
        </button>
      ))}
    </div>
  );
}
