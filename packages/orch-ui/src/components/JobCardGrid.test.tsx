import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCardGrid, getConsecutiveFailures } from './JobCardGrid.js';
import type { Job, RuntimeEntry } from '../types.js';

const JOB = (id: string, label: string): Job => ({
  id, type: 'cron', label, command: 'echo hi',
  enabled: true, triggerMode: 'fire-and-forget',
});
const HISTORY: RuntimeEntry[] = [];

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('JobCardGrid', () => {
  it('renders spinner when items is undefined', () => {
    wrap(<JobCardGrid />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders correct number of cards when items provided', () => {
    wrap(<JobCardGrid items={[
      { job: JOB('j1', 'Job A'), runHistory: HISTORY },
      { job: JOB('j2', 'Job B'), runHistory: HISTORY },
    ]} />);
    expect(screen.getByText('Job A')).toBeInTheDocument();
    expect(screen.getByText('Job B')).toBeInTheDocument();
  });

  it('renders "No jobs" message when empty array', () => {
    wrap(<JobCardGrid items={[]} />);
    expect(screen.getByText(/no jobs/i)).toBeInTheDocument();
  });

  it('each card shows job label', () => {
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'My Cron'), runHistory: HISTORY }]} />);
    expect(screen.getByText('My Cron')).toBeInTheDocument();
  });
});

const FAILED = (code: number): RuntimeEntry => ({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: code, pid: 1 });
const SKIPPED = (code: number | null): RuntimeEntry => ({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: code, pid: null, skipped: true });

describe('getConsecutiveFailures', () => {
  it('counts real failures at the head of the history', () => {
    expect(getConsecutiveFailures([FAILED(1), FAILED(2)])).toBe(2);
  });

  // The alert threshold is what turns this number red in the card, so a forgiven exit code
  // leaking into it is a false alarm on its own.
  it('does not count skipped runs, whatever exit code they carry', () => {
    expect(getConsecutiveFailures([SKIPPED(2), SKIPPED(null)])).toBe(0);
  });

  it('sees through a skipped run to the failures around it', () => {
    expect(getConsecutiveFailures([FAILED(1), SKIPPED(2), FAILED(1)])).toBe(2);
  });

  it('still stops at the first success', () => {
    expect(getConsecutiveFailures([FAILED(1), SKIPPED(2), { startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 }, FAILED(1)])).toBe(1);
  });
});

describe('JobCardGrid status column', () => {
  it('labels a skipped last run "Skipped"', () => {
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'Locked scraper'), runHistory: [SKIPPED(2)] }]} />);
    expect(screen.getAllByText('Skipped').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
});
