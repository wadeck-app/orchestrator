import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { RunHistory } from './RunHistory.js';
import { JobCard } from './JobCard.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { JOB_STATUS_VARIANT } from './JobStatusPill.js';
import type { Job, RuntimeEntry } from '../types.js';

/*
 * A forced end used to be one "Cancelled" for a timeout, a user's kill and a resource-limit kill, and a run the
 * daemon learned of late looked like any other. The daemon now records why (endReason) and whether it was late.
 */
const JOB: Job = {
  id: 'j1', type: 'cron', label: 'WhatsApp', command: 'wa-scraper',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *',
};

function run(extra: Partial<RuntimeEntry>): RuntimeEntry {
  return { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:05:00Z', exitCode: 1, pid: 1, ...extra };
}

function history(entry: RuntimeEntry) {
  return render(<MemoryRouter><RunHistory entries={[entry]} /></MemoryRouter>);
}

function card(entry: RuntimeEntry) {
  return render(
    <MemoryRouter>
      <JobCard job={JOB} runHistory={[entry]} onTrigger={vi.fn()} onToggle={vi.fn()} />
    </MemoryRouter>,
  );
}

const LATE_TOOLTIP = 'Ended while the daemon was down; the daemon learned of it at its next start';

describe('RunHistory - how a forced run ended', () => {
  it('names a timeout, whose exit code is the child\'s own and non-null', () => {
    history(run({ endReason: 'timeout', exitCode: 1 }));
    expect(screen.getByText('Timed out')).toBeInTheDocument();
    expect(screen.queryByText(/Failed/)).toBeNull();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });

  it('names a kill by the user', () => {
    history(run({ endReason: 'manual-kill', exitCode: null, cancelledByUser: true }));
    expect(screen.getByText('Killed by you')).toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });

  it('names a resource-limit kill', () => {
    history(run({ endReason: 'resource-limit', exitCode: 1 }));
    expect(screen.getByText('Killed: resource limit')).toBeInTheDocument();
  });

  it('reads a legacy cancelledByUser entry as a kill by the user', () => {
    history(run({ exitCode: null, cancelledByUser: true }));
    expect(screen.getByText('Killed by you')).toBeInTheDocument();
  });

  // Old data must never be mislabelled as a timeout.
  it('keeps the generic "Cancelled" for a legacy entry with a null exit code and no reason', () => {
    history(run({ exitCode: null }));
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByText('Timed out')).toBeNull();
  });

  it('uses a distinct tone for each reason', () => {
    const tones = [JOB_STATUS_VARIANT['timed-out'], JOB_STATUS_VARIANT['killed'], JOB_STATUS_VARIANT['resource-killed']];
    expect(new Set(tones).size).toBe(3);
  });
});

describe('RunHistory - a run the daemon learned of late', () => {
  it('shows a Late marker with its explanation', () => {
    history(run({ exitCode: 0, late: true }));
    expect(screen.getByText('Late')).toBeInTheDocument();
    expect(screen.getByTitle(LATE_TOOLTIP)).toBeInTheDocument();
  });

  it('shows none for a run the daemon watched end', () => {
    history(run({ exitCode: 0 }));
    expect(screen.queryByText('Late')).toBeNull();
  });
});

describe('JobCard - how the last run ended', () => {
  it('names a timed-out last run', () => {
    card(run({ endReason: 'timeout' }));
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });

  it('names a user kill', () => {
    card(run({ endReason: 'manual-kill', exitCode: null }));
    expect(screen.getByText('Killed by you')).toBeInTheDocument();
  });

  it('keeps "Cancelled" for a legacy null-exit entry', () => {
    card(run({ exitCode: null }));
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
  });

  it('marks a late last run on the last-run line', () => {
    card(run({ exitCode: 0, late: true }));
    expect(screen.getByTitle(LATE_TOOLTIP)).toBeInTheDocument();
  });

  it('has no Late marker otherwise', () => {
    card(run({ exitCode: 0 }));
    expect(screen.queryByText('Late')).toBeNull();
  });
});

describe('JobStatusBadge - endReason', () => {
  it('shows the reason ahead of the exit code', () => {
    render(<JobStatusBadge exitCode={1} endReason="timeout" />);
    expect(screen.getByText('Timed out')).toBeInTheDocument();
  });

  it('a skipped run stays Skipped whatever the reason', () => {
    render(<JobStatusBadge exitCode={2} skipped endReason="timeout" />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });
});
