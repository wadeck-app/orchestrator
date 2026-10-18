import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JobConfigDisplay } from './JobConfigDisplay.js';
import type { Job } from '../types.js';

const CRON_JOB: Job = {
  id: 'j1', type: 'cron', label: 'Test', command: 'pg_dump mydb',
  cwd: '/opt', schedule: '0 10 * * *', enabled: true,
  triggerMode: 'fire-and-forget', missedFiring: 'skip',
};
const STARTUP_JOB: Job = {
  id: 'j2', type: 'startup', label: 'Start', command: 'node server.js',
  enabled: true, triggerMode: 'wait', delaySeconds: 5,
};

describe('JobConfigDisplay', () => {
  it('shows command value', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('pg_dump mydb')).toBeInTheDocument();
  });

  it('shows schedule for cron jobs', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('0 10 * * *')).toBeInTheDocument();
  });

  it('shows delaySeconds for startup jobs', () => {
    render(<JobConfigDisplay job={STARTUP_JOB} />);
    expect(screen.getByText('5s')).toBeInTheDocument();
  });

  it('shows triggerMode value', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('fire-and-forget')).toBeInTheDocument();
  });

  it('shows missedFiring when present', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('skip')).toBeInTheDocument();
  });

  it('does not show schedule section for startup jobs', () => {
    render(<JobConfigDisplay job={STARTUP_JOB} />);
    expect(screen.queryByText('0 10 * * *')).toBeNull();
  });
});
