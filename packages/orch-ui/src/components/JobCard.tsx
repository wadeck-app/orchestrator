import React from 'react';
import type { Job, RuntimeEntry } from '../types.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { NextFireCountdown } from './NextFireCountdown.js';
import { TriggerButton } from './TriggerButton.js';
import { EnableToggle } from './EnableToggle.js';

interface Props {
  job: Job;
  lastRun: RuntimeEntry | null;
  onTrigger: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onClick?: () => void;
}

const TYPE_COLORS: Record<Job['type'], string> = {
  cron: 'bg-purple-100 text-purple-700',
  startup: 'bg-blue-100 text-blue-700',
  once: 'bg-gray-100 text-gray-600',
};

export function JobCard({ job, lastRun, onTrigger, onToggle, onClick }: Props): React.ReactElement {
  return (
    <div
      className="rounded-lg border border-gray-200 p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer bg-white"
      onClick={onClick}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-gray-900 truncate">{job.label}</span>
          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0 ${TYPE_COLORS[job.type]}`}>
            {job.type}
          </span>
        </div>
        <EnableToggle job={job} onToggle={onToggle} />
      </div>

      {/* Body */}
      <div className="flex items-center gap-3 mb-3">
        <JobStatusBadge exitCode={lastRun?.exitCode ?? null} />
        <NextFireCountdown job={job} />
      </div>

      {/* Footer */}
      <div className="flex justify-end">
        <TriggerButton jobId={job.id} onTrigger={onTrigger} />
      </div>
    </div>
  );
}
