import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { JobListSection } from './JobListSection.js';
import type { JobWithHistory } from '../job-with-history.js';
import type { Job, RuntimeEntry } from '../types.js';

function job(id: string, label: string): Job {
  return { id, type: 'cron', label, command: `${id}-cmd`, enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *' };
}

const IN_FLIGHT: RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 1 };
const FAILED:    RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:05Z', exitCode: 3, pid: 2 };
const CANCELLED: RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:05Z', exitCode: null, pid: 3, cancelledByUser: true };
const OK:        RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:05Z', exitCode: 0, pid: 4 };

const JOBS: JobWithHistory[] = [
  { job: job('running', 'Running job'),     runHistory: [IN_FLIGHT] },
  { job: job('failed', 'Failed job'),       runHistory: [FAILED] },
  { job: job('cancelled', 'Cancelled job'), runHistory: [CANCELLED] },
  { job: job('ok', 'Healthy job'),          runHistory: [OK] },
];

function renderList() {
  return render(<MemoryRouter><JobListSection jobs={JOBS} /></MemoryRouter>);
}

describe('JobListSection "Failed" filter', () => {
  it('lists every job before filtering', () => {
    renderList();
    for (const label of ['Running job', 'Failed job', 'Cancelled job', 'Healthy job']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  // The filter used to match `exitCode !== 0`, which is true for null: an in-flight run and a
  // run killed by signal both have no exit code, so both were reported as failures.
  it('keeps only the run that ended with a non-zero exit code', async () => {
    renderList();
    await userEvent.click(screen.getByText('Failed'));

    expect(screen.getByText('Failed job')).toBeInTheDocument();
    expect(screen.queryByText('Running job')).toBeNull();
    expect(screen.queryByText('Cancelled job')).toBeNull();
    expect(screen.queryByText('Healthy job')).toBeNull();
  });
});
