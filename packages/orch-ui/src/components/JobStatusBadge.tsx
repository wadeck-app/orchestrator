import React from 'react';

interface Props {
  exitCode: number | null;
  running?: boolean;
}

export function JobStatusBadge({ exitCode, running }: Props): React.ReactElement {
  if (running) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">Running</span>;
  }
  if (exitCode === 0) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">OK</span>;
  }
  if (exitCode !== null) {
    return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">Failed ({exitCode})</span>;
  }
  return <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-600">Never run</span>;
}
