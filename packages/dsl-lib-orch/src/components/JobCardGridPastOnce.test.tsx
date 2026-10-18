import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { JobCardGrid } from './JobCardGrid.js';
import type { Job, RuntimeEntry } from '../types.js';

/*
 * A spent `once` job is kept in the registry now rather than deleted, so the grid receives jobs that
 * have nothing left to do. Up to the retention bound that is fifty extra cards, each showing uptime, a
 * streak and a "next run" for a firing that already happened.
 *
 * Every filter therefore excludes them, and the new "Past once" chip is the only one that shows them.
 * The default view is unchanged by design: nothing looks different until the chip is used.
 */

const HISTORY: RuntimeEntry[] = [];

const CRON: Job = {
  id: 'nightly', type: 'cron', label: 'Nightly', command: 'echo tick',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *',
};
const PENDING_ONCE: Job = {
  id: 'deploy-later', type: 'once', label: 'Deploy later', command: 'echo go',
  enabled: true, triggerMode: 'fire-and-forget', delayMs: 3_600_000,
};
const SPENT_ONCE: Job = {
  id: 'deploy-done', type: 'once', label: 'Deploy done', command: 'echo done',
  enabled: true, triggerMode: 'fire-and-forget', delayMs: 1000,
  spent: true, spentAt: '2026-09-18T10:00:00.000Z',
};

const ALL = [CRON, PENDING_ONCE, SPENT_ONCE].map(job => ({ job, runHistory: HISTORY }));

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('spent once jobs are out of every default view', () => {
  it('the All filter hides them', () => {
    wrap(<JobCardGrid items={ALL} filter="all" />);
    expect(screen.queryByText('Deploy done')).toBeNull();
    expect(screen.getByText('Nightly')).toBeInTheDocument();
    expect(screen.getByText('Deploy later')).toBeInTheDocument();
  });

  it('the Once filter shows the firing still to come, not the one already done', () => {
    wrap(<JobCardGrid items={ALL} filter="once" />);
    expect(screen.getByText('Deploy later')).toBeInTheDocument();
    expect(screen.queryByText('Deploy done')).toBeNull();
  });

  it('no filter at all behaves like All', () => {
    wrap(<JobCardGrid items={ALL} />);
    expect(screen.queryByText('Deploy done')).toBeNull();
  });
});

describe('the Past once filter', () => {
  it('shows only spent once jobs', () => {
    wrap(<JobCardGrid items={ALL} filter="past-once" />);
    expect(screen.getByText('Deploy done')).toBeInTheDocument();
    expect(screen.queryByText('Deploy later')).toBeNull();
    expect(screen.queryByText('Nightly')).toBeNull();
  });

  it('search still applies inside it', () => {
    wrap(<JobCardGrid items={ALL} filter="past-once" search="nothing-matches-this" />);
    expect(screen.queryByText('Deploy done')).toBeNull();
  });

  it('says so when there is no past to show, rather than rendering an unexplained blank', () => {
    wrap(<JobCardGrid items={[{ job: CRON, runHistory: HISTORY }]} filter="past-once" />);
    expect(screen.getByText(/no jobs/i)).toBeInTheDocument();
  });
});

describe('the Failed filter', () => {
  const FAILED: RuntimeEntry = {
    startedAt: '2026-09-18T10:00:00Z', finishedAt: '2026-09-18T10:00:01Z', exitCode: 1, pid: 1,
  };

  // A spent once job that failed is history, and history belongs in the Past once view. Leaving it in
  // Failed would keep a permanent red card for a one-off job nobody can fix by re-running the schedule.
  it('does not surface a spent once job, even one whose run failed', () => {
    wrap(<JobCardGrid items={[{ job: SPENT_ONCE, runHistory: [FAILED] }]} filter="failed" />);
    expect(screen.queryByText('Deploy done')).toBeNull();
  });
});
