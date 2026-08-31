import React from 'react';
import type { Job } from '../types.js';

interface Props {
  job: Job;
}

export function NextFireCountdown({ job }: Props): React.ReactElement {
  if (job.type === 'startup') {
    return <span className="text-sm text-gray-500">On startup</span>;
  }
  if (job.type === 'once') {
    return <span className="text-sm text-gray-500">Once</span>;
  }
  // cron: display raw schedule -- next-fire calculation deferred to v2
  return <span className="text-sm text-gray-500">Cron: {job.schedule ?? '—'}</span>;
}
