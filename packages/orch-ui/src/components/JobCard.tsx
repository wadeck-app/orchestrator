import React from 'react';
import type { Job, RuntimeEntry } from '../types.js';
import { BADGE_FAILED, BADGE_NEVER, BADGE_OK, BADGE_RUNNING } from './JobStatusBadge.js';
import { NextFireCountdown } from './NextFireCountdown.js';
import { TriggerButton } from './TriggerButton.js';
import { EnableToggle } from './EnableToggle.js';

interface Props {
  job: Job;
  runHistory: RuntimeEntry[];
  onTrigger: (id: string) => Promise<void>;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onClick?: () => void;
}

// violations-suppress-start: tailwind/no-raw-color-class job-type colors (cron/startup/once) have no semantic-token equivalents in the design system; raw Tailwind palette is the only option
// @formatter:off
const TYPE_COLORS: Record<Job['type'], string> = {
  cron:    'bg-purple-100 text-purple-700',
  startup: 'bg-blue-100 text-blue-700',
  once:    'bg-gray-100 text-gray-600',
};
// @formatter:on
// violations-suppress-end: tailwind/no-raw-color-class

// @formatter:off
const CARD_CLS       = 'rounded-lg border border-border p-4 shadow-sm hover:shadow-md transition-shadow cursor-pointer bg-surface';
const TYPE_BADGE_BASE = 'inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium shrink-0';
// @formatter:on

export function relativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 60)  return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function jobListBadge(runHistory: RuntimeEntry[]): React.ReactElement {
  if (runHistory.length === 0) return <span className={BADGE_NEVER}>Never run</span>;
  const last = runHistory[0]!;
  if (last.exitCode === null) return <span className={BADGE_RUNNING}>Running</span>;
  if (last.exitCode === 0) return <span className={BADGE_OK}>OK</span>;
  // Count consecutive failures from the most recent run
  const failCount = runHistory.filter(e => e.exitCode !== null && e.exitCode !== 0).length;
  return <span className={BADGE_FAILED}>{failCount}x failed</span>;
}

/**
 * @registryCategory composite
 * @registryTags job card
 */
export function JobCard({ job, runHistory, onTrigger, onToggle, onClick }: Props): React.ReactElement {
  return (
    <div
      className={CARD_CLS}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-content truncate">{job.label}</span>
          <span className={`${TYPE_BADGE_BASE} ${TYPE_COLORS[job.type]}`}>
            {job.type}
          </span>
        </div>
        <EnableToggle job={job} onToggle={onToggle} />
      </div>

      <div className="flex items-center gap-3 mb-1">
        {jobListBadge(runHistory)}
        <NextFireCountdown job={job} />
      </div>
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-muted">
          {runHistory[0]
            ? (() => {
                const last = runHistory[0]!;
                const t = `Last run: ${relativeTime(last.startedAt)}`;
                if (last.finishedAt) {
                  const ms = new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime();
                  if (ms >= 0) {
                    const s = ms / 1000;
                    const dur = s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
                    return `${t} (${dur})`;
                  }
                }
                return t;
              })()
            : 'Last run: Never'}
        </p>
        {/* Mini run history: last 5 runs as colored dots */}
        {runHistory.length > 0 && (
          <div className="flex items-center gap-0.5 ml-auto">
            {Array.from({ length: 5 }, (_, i) => {
              const entry = runHistory[i];
              let cls = 'bg-border';
              if (entry) {
                if (entry.exitCode === null) cls = 'bg-gray-400';
                // violations-suppress: tailwind/no-raw-color-class pass/fail dot colors have no semantic-token equivalents
                else if (entry.exitCode === 0) cls = 'bg-green-500';
                else cls = 'bg-red-500';
              }
              return <span key={i} className={`w-1.5 h-1.5 rounded-full ${cls}`} />;
            })}
          </div>
        )}
      </div>

      <div className="flex justify-end">
        <TriggerButton jobId={job.id} onTrigger={onTrigger} />
      </div>
    </div>
  );
}
