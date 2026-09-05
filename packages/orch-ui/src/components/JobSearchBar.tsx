import React from 'react';

export interface JobSearchBarProps {
  value?: string;
  onChange?: (v: string) => void;
  placeholder?: string;
}

// @formatter:off
const INPUT_CLS = 'w-full border border-border rounded-md px-3 py-2 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary';
// @formatter:on

/**
 * @registryCategory atomic
 * @registryTags search jobs filter input
 */
export function JobSearchBar({ value = '', onChange, placeholder = 'Search jobs...' }: JobSearchBarProps): React.ReactElement {
  return (
    // violations-suppress: react/no-raw-input labelless search bar - context (job list) makes purpose clear
    <input
      type="text"
      placeholder={placeholder}
      value={value}
      onChange={e => onChange?.(e.target.value)}
      className={INPUT_CLS}
    />
  );
}
