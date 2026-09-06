import React from 'react';

// @formatter:off
const SWITCHER_INACTIVE = 'text-xs px-2.5 py-1 rounded border border-border text-content hover:bg-muted-bg transition-colors';
// @formatter:on

export interface DesignSwitcherProps {
  jobId?: string;
  current?: string;
}

/**
 * @registryCategory atomic
 * @registryTags design switcher navigation compare
 */
export function DesignSwitcher({ jobId, current }: DesignSwitcherProps): React.ReactElement {
  const designs = [
    { id: 'design-a', label: 'Design A - Banner' },
    { id: 'design-b', label: 'Design B - Alert' },
    { id: 'design-c', label: 'Design C - Inline' },
  ];
  return (
    <div className="flex items-center gap-2 mb-3 flex-wrap">
      <span className="text-xs text-muted mr-1">Designs:</span>
      {designs.map(d => (
        <a
          key={d.id}
          href={`/jobs/${jobId}/${d.id}`}
          className={`text-xs px-2.5 py-1 rounded border transition-colors ${
            current === d.id
              ? 'bg-primary text-on-primary border-primary font-medium text-xs px-2.5 py-1 rounded border transition-colors'
              : SWITCHER_INACTIVE
          }`}
        >
          {d.label}
        </a>
      ))}
      <a
        href={`/jobs/${jobId}`}
        className={SWITCHER_INACTIVE}
      >
        Default
      </a>
    </div>
  );
}
