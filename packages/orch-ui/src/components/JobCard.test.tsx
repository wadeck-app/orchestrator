import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCard } from './JobCard.js';
import type { Job, RuntimeEntry } from '../types.js';

const BASE_JOB: Job = {
  id: 'j1', type: 'cron', label: 'WhatsApp', command: 'wa-scraper',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *',
};

function entry(exitCode: number | null, pid = 1): RuntimeEntry {
  return { startedAt: '2026-09-02T10:00:00Z', exitCode, pid };
}

function renderCard(runHistory: RuntimeEntry[]) {
  return render(
    <MemoryRouter>
      <JobCard job={BASE_JOB} runHistory={runHistory} onTrigger={vi.fn()} onToggle={vi.fn()} />
    </MemoryRouter>
  );
}

describe('JobCard status badge on the list page', () => {
  it('shows "Never run" when no history', () => {
    renderCard([]);
    expect(screen.getByText('Never run')).toBeInTheDocument();
  });

  it('shows "OK" when last run succeeded', () => {
    renderCard([entry(0)]);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('shows "5x failed" when 5 consecutive failures - NOT "Failed (1)"', () => {
    renderCard([entry(1), entry(1), entry(1), entry(1), entry(1)]);
    // Must show count, not exit code
    expect(screen.getByText('5x failed')).toBeInTheDocument();
    expect(screen.queryByText(/Failed \(/)).toBeNull();
  });

  it('shows "3x failed" for 3 failures even with different exit codes', () => {
    renderCard([entry(1), entry(2), entry(127)]);
    expect(screen.getByText('3x failed')).toBeInTheDocument();
  });

  it('shows "1x failed" for a single failure', () => {
    renderCard([entry(1)]);
    expect(screen.getByText('1x failed')).toBeInTheDocument();
  });

  it('shows "OK" when latest run succeeded even if prior runs failed', () => {
    renderCard([entry(0), entry(1), entry(1)]);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
});
