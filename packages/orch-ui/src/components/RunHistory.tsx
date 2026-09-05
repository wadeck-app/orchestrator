import React from 'react';
import type { RuntimeEntry } from '../types.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { TriggerBadge } from './TriggerBadge.js';

export interface RunHistoryProps {
  entries: RuntimeEntry[];
}

function formatDuration(entry: RuntimeEntry): string {
  if (entry.exitCode === null) return 'running...';
  if (!entry.finishedAt) return '-';
  const ms = new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime();
  if (ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * @registryCategory composite
 * @registryTags history table runs
 */
export function RunHistory({ entries }: RunHistoryProps): React.ReactElement {
  if (!entries || entries.length === 0) {
    return <p className="text-sm text-muted italic">No runs yet</p>;
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-muted border-b">
          <th className="pb-1 font-medium">Started</th>
          <th className="pb-1 font-medium">Duration</th>
          <th className="pb-1 font-medium">Peak CPU</th>
          <th className="pb-1 font-medium">Peak RAM</th>
          <th className="pb-1 font-medium">Result</th>
          <th className="pb-1 font-medium">Triggered by</th>
          <th className="pb-1 font-medium">PID</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => {
          const date = new Date(entry.startedAt);
          // violations-suppress: ts/no-locale-date no shared formatter in orch-ui; toLocaleString acceptable here because run timestamps are display-only and test assertions use DOM presence, not text content, so locale does not affect test correctness
          const formatted = isNaN(date.getTime()) ? entry.startedAt : date.toLocaleString();
          return (
            <tr key={i}>
              <td className="py-1 pr-4 text-content">{formatted}</td>
              <td className="py-1 pr-4 text-muted">{formatDuration(entry)}</td>
              <td className="py-1 pr-4 text-muted">{entry.peakCpuPct != null ? `${entry.peakCpuPct.toFixed(1)}%` : '-'}</td>
              <td className="py-1 pr-4 text-muted">{entry.peakRamMb  != null ? `${entry.peakRamMb.toFixed(0)}MB` : '-'}</td>
              <td className="py-1 pr-4"><JobStatusBadge exitCode={entry.exitCode} /></td>
              <td className="py-1 pr-4"><TriggerBadge source={entry.triggeredBy} /></td>
              <td className="py-1 text-muted">{entry.pid ?? '-'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
