import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCardGrid } from './JobCardGrid.js';
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
