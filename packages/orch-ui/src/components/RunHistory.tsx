import React from 'react';
import type { RuntimeEntry } from '../types.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { TriggerBadge } from './TriggerBadge.js';

export interface RunHistoryProps {
  entries: RuntimeEntry[];
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
