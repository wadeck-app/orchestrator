import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobCard } from './JobCard.js';
import { JOB_STATUS_VARIANT } from './JobStatusPill.js';
import type { Job, RuntimeEntry } from '../types.js';

/*
 * Two shapes the card could not express.
 *
 * A cron job waiting for its window to open is enabled and correctly doing nothing. The status pill had
 * no word for it: "Never run" is what it showed, which is true and useless -- it is what a broken job
 * shows too. `pending` is a third state, not a flavour of disabled.
 *
 * And a `once` job was rendered with the furniture of a recurring one: an uptime percentage over a
 * single run, a success streak that cannot reach two, five run dots of which four are always empty, and
 * a Logs link to a run that has not happened. All of it is noise for a job with exactly one firing.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const OK = (at: string): RuntimeEntry => ({
  startedAt: at, finishedAt: at, exitCode: 0, pid: 1,
});

const CRON: Job = {
  id: 'nightly', type: 'cron', label: 'Nightly', command: 'echo tick',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *',
};
const PENDING_ONCE: Job = {
  id: 'deploy', type: 'once', label: 'Deploy', command: 'echo go',
  enabled: true, triggerMode: 'fire-and-forget',
  delayMs: 3 * HOUR, scheduledAt: new Date(NOW).toISOString(),
};
const SPENT_ONCE: Job = {
  ...PENDING_ONCE, id: 'deployed', label: 'Deployed',
  spent: true, spentAt: new Date(NOW - 2 * DAY).toISOString(),
};

function renderCard(job: Job, runHistory: RuntimeEntry[] = [], uptimePercent: number | null = 100) {
  return render(
    <MemoryRouter>
      <JobCard job={job} runHistory={runHistory} uptimePercent={uptimePercent} />
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// The pending status
// ---------------------------------------------------------------------------

describe('a cron job whose window has not opened', () => {
  it('reads as Pending, not as Never run', () => {
    renderCard({ ...CRON, activeFrom: new Date(NOW + 3 * DAY).toISOString() });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Never run')).toBeNull();
  });

  // Enabled-but-not-yet-started is the job working as configured, so it must not borrow danger's red.
  it('the pending variant is neutral, not a failure colour', () => {
    expect(JOB_STATUS_VARIANT.pending).not.toBe('danger');
  });

  it('a job already inside its window is unaffected', () => {
    renderCard({ ...CRON, activeFrom: new Date(NOW - DAY).toISOString() }, []);
    expect(screen.queryByText('Pending')).toBeNull();
    expect(screen.getByText('Never run')).toBeInTheDocument();
  });

  // A real run outranks the window: once the job has fired, its outcome is the more useful fact.
  it('a pending job that has somehow already run shows the run outcome', () => {
    renderCard({ ...CRON, activeFrom: new Date(NOW + DAY).toISOString() }, [OK('2026-09-18T03:00:00Z')]);
    expect(screen.getByText('OK')).toBeInTheDocument();
    expect(screen.queryByText('Pending')).toBeNull();
  });

  it('an expired window is not called pending', () => {
    renderCard({ ...CRON, activeUntil: new Date(NOW - DAY).toISOString() }, []);
    expect(screen.queryByText('Pending')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The once-job shape
// ---------------------------------------------------------------------------

describe('a once job card drops the recurring-job furniture', () => {
  it('no uptime percentage -- a share of one run is 0% or 100% and means nothing', () => {
    renderCard(PENDING_ONCE, [], 100);
    // The rendered label is "100.0% uptime"; asserting on "100%" would pass without proving anything.
    expect(screen.queryByText('100.0% uptime')).toBeNull();
    expect(screen.queryByText(/uptime/i)).toBeNull();
  });

  it('no run dots -- four of the five would always be empty', () => {
    const { container } = renderCard(SPENT_ONCE, [OK('2026-09-17T12:00:00Z')]);
    expect(container.querySelectorAll('[data-run-dot]').length).toBe(0);
  });

  it('a cron job keeps both, so this is a once-job shape and not a removal', () => {
    const { container } = renderCard(CRON, [OK('2026-09-18T03:00:00Z')], 100);
    expect(screen.getByText('100.0% uptime')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-run-dot]').length).toBeGreaterThan(0);
  });

  it('no Logs link before the single run has happened', () => {
    renderCard(PENDING_ONCE, []);
    expect(screen.queryByText('Logs')).toBeNull();
  });

  // A spent job does have a log, and it is the only record of what happened.
  it('a spent once job keeps its Logs link', () => {
    renderCard(SPENT_ONCE, [OK('2026-09-17T12:00:00Z')]);
    expect(screen.getByText('Logs')).toBeInTheDocument();
  });

  it('the label, the type badge and the countdown all stay', () => {
    renderCard(PENDING_ONCE, []);
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.getByText('once')).toBeInTheDocument();
    expect(screen.getByText('in 3h')).toBeInTheDocument();
  });

  it('a cron job with no runs still offers Logs, which is where a failure to start shows up', () => {
    renderCard(CRON, []);
    expect(screen.getByText('Logs')).toBeInTheDocument();
  });
});
