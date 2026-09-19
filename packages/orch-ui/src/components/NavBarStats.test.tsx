import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NavBar } from './NavBar.js';
import type { Job, RuntimeEntry } from '../types.js';

/*
 * The header counter is a default view like any other, so it has to agree with the job grid beside it:
 * with four cron jobs listed and four spent `once` jobs hidden, "8 jobs" contradicts what the user can
 * count on screen and reads as jobs that have gone missing from the grid.
 */

const FAILED: RuntimeEntry = {
  startedAt: '2026-09-18T10:00:00Z', finishedAt: '2026-09-18T10:00:01Z', exitCode: 1, pid: 1,
};

const CRON: Job = {
  id: 'nightly', type: 'cron', label: 'Nightly', command: 'echo tick',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *',
};
const SPENT_ONCE: Job = {
  id: 'deploy-done', type: 'once', label: 'Deploy done', command: 'echo done',
  enabled: true, triggerMode: 'fire-and-forget', delayMs: 1000,
  spent: true, spentAt: '2026-09-18T10:00:00.000Z',
};

function mockJobs(items: { job: Job; runHistory: RuntimeEntry[] }[]): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ json: () => Promise.resolve(items) })));
}

describe('NavBar stats exclude past once jobs', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('counts only the jobs the grid shows', async () => {
    mockJobs([
      { job: CRON, runHistory: [] },
      { job: SPENT_ONCE, runHistory: [] },
    ]);
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('1 jobs')).toBeInTheDocument());
  });

  it('a spent once job whose run failed does not hold the failure badge open forever', async () => {
    mockJobs([
      { job: CRON, runHistory: [] },
      { job: SPENT_ONCE, runHistory: [FAILED] },
    ]);
    render(<MemoryRouter><NavBar /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('All OK')).toBeInTheDocument());
    expect(screen.queryByText(/failed/)).toBeNull();
  });
});
