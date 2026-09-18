import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCard, runDotState } from './JobCard.js';
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

// A run in progress used to be a grey dot among the coloured ones, which reads as "no result"
// rather than "going". It is a blue play triangle now.
describe('JobCard run history dots', () => {
  it('marks a run in progress with a play icon, not a dot', () => {
    const { container } = renderCard([entry(null)]);

    const running = container.querySelector('[data-run-state="running"]');
    expect(running).not.toBeNull();
    // An svg, so it is the icon and not a recoloured circle.
    expect(running!.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  // Blue, via the semantic token. Amber would read as a warning, and a run in progress is not one.
  it('colours the running icon with the primary token rather than a grey or amber literal', () => {
    const { container } = renderCard([entry(null)]);

    const running = container.querySelector('[data-run-state="running"]')!;
    expect(running.getAttribute('class')).toContain('text-primary');
    expect(running.getAttribute('class')).not.toContain('gray');
    expect(running.getAttribute('class')).not.toContain('orange');
    expect(running.getAttribute('class')).not.toContain('yellow');
  });

  it('still draws finished runs as dots', () => {
    const { container } = renderCard([entry(0), entry(1)]);

    expect(container.querySelector('[data-run-state="ok"]')!.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('[data-run-state="failed"]')!.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('[data-run-state="running"]')).toBeNull();
  });

  it('always shows five slots, padding with empties', () => {
    const { container } = renderCard([entry(0)]);
    expect(container.querySelectorAll('[data-run-state]').length).toBe(5);
    expect(container.querySelectorAll('[data-run-state="empty"]').length).toBe(4);
  });
});

describe('runDotState', () => {
  it('maps every case', () => {
    expect(runDotState(undefined)).toBe('empty');
    expect(runDotState(entry(null))).toBe('running');
    expect(runDotState(entry(0))).toBe('ok');
    expect(runDotState(entry(1))).toBe('failed');
  });
});

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
