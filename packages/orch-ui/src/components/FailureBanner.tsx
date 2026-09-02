import React from 'react';
import type { RuntimeEntry } from '../types.js';

export interface FailureEntry {
  jobId: string;
  entry: RuntimeEntry;
  jobLabel?: string;
}

export interface FailureBannerProps {
  failures: FailureEntry[];
  onAcknowledge: () => void;
}

export function FailureBanner({ failures, onAcknowledge }: FailureBannerProps): React.ReactElement | null {
  if (failures.length === 0) return null;
  const names = failures.map(f => f.jobLabel ?? f.jobId).join(', ');
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-2 bg-surface border-b border-border text-sm">
      <div className="flex items-center gap-2 min-w-0">
        {/* violations-suppress: tailwind/no-raw-color-class no semantic token for inline status dot */}
        <span className="shrink-0 w-2 h-2 rounded-full bg-red-500" />
        <span className="text-content font-medium shrink-0">
          {failures.length} job{failures.length > 1 ? 's' : ''} failed:
        </span>
        <span className="text-muted truncate">{names}</span>
      </div>
      <button
        onClick={onAcknowledge}
        className="shrink-0 px-3 py-1 rounded border border-border text-xs font-medium text-content hover:bg-muted-bg transition-colors"
      >
        Acknowledge
      </button>
    </div>
  );
}
