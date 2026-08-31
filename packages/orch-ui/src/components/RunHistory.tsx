import React from 'react';
import type { RuntimeEntry } from '../types.js';
import { JobStatusBadge } from './JobStatusBadge.js';

interface Props {
  lastRun: RuntimeEntry | null;
}

export function RunHistory({ lastRun }: Props): React.ReactElement {
  if (!lastRun) {
    return <p className="text-sm text-gray-400 italic">No runs yet</p>;
  }

  const date = new Date(lastRun.startedAt);
  const formatted = isNaN(date.getTime()) ? lastRun.startedAt : date.toLocaleString();

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-gray-500 border-b">
          <th className="pb-1 font-medium">Started</th>
          <th className="pb-1 font-medium">Result</th>
          <th className="pb-1 font-medium">PID</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="py-1 pr-4 text-gray-700">{formatted}</td>
          <td className="py-1 pr-4"><JobStatusBadge exitCode={lastRun.exitCode} /></td>
          <td className="py-1 text-gray-500">{lastRun.pid ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  );
}
