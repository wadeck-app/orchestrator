import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobCardGrid } from './JobCardGrid.js';
import type { Job, ProgressEstimate, RuntimeEntry } from '../types.js';

// Each card of the grid shows the estimate of its OWN job, and only while that job is running. The clock is frozen at
// the daemon's "now" so the percentages are the estimates' own.
const NOW = Date.parse('2026-10-20T14:00:00.000Z');

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const JOB = (id: string, label: string): Job => ({
  id, type: 'cron', label, command: 'echo hi', schedule: '0 * * * *', enabled: true, triggerMode: 'fire-and-forget',
});
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-10-20T13:55:00Z', exitCode: null, pid: 7 }];
const DONE: RuntimeEntry[] = [{ startedAt: '2026-10-20T13:00:00Z', finishedAt: '2026-10-20T13:05:00Z', exitCode: 0, pid: 7 }];

function estimate(progress: number | null, over: Partial<ProgressEstimate> = {}): ProgressEstimate {
  return {
    strategyId: 'history', progress, etaAt: progress === null ? null : '2026-10-20T14:10:00.000Z',
    confidence: progress === null ? 'none' : 'high', confidenceScore: 0.9,
    reason: 'auto: history', serverNow: new Date(NOW).toISOString(), ...over,
  };
}

function cardOf(label: string): HTMLElement {
  return screen.getByText(label).closest('[class*="shadow-sm"]') as HTMLElement;
}

function renderGrid(items: React.ComponentProps<typeof JobCardGrid>['items']) {
  return render(<MemoryRouter><JobCardGrid items={items} /></MemoryRouter>);
}

describe('JobCardGrid progress', () => {
  it('puts each estimate on the card of its own job', () => {
    renderGrid([
      { job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.25) },
      { job: JOB('b', 'Beta'), runHistory: RUNNING, progress: estimate(0.75) },
    ]);

    expect(cardOf('Alpha').textContent).toContain('25%');
    expect(cardOf('Alpha').textContent).not.toContain('75%');
    expect(cardOf('Beta').textContent).toContain('75%');
    expect(cardOf('Beta').textContent).not.toContain('25%');
  });

  it('shows nothing on a card whose job is not running, even with an estimate', () => {
    renderGrid([{ job: JOB('a', 'Alpha'), runHistory: DONE, progress: estimate(0.5) }]);

    expect(within(cardOf('Alpha')).queryByText(/50%/)).toBeNull();
    expect(cardOf('Alpha').querySelector('[data-progress-state]')).toBeNull();
  });

  it('shows nothing on a running card without an estimate, without disturbing the others', () => {
    renderGrid([
      { job: JOB('a', 'Alpha'), runHistory: RUNNING },
      { job: JOB('b', 'Beta'), runHistory: RUNNING, progress: estimate(0.5) },
    ]);

    expect(cardOf('Alpha').querySelector('[data-progress-state]')).toBeNull();
    expect(cardOf('Beta').querySelector('[data-progress-state="estimate"]')).not.toBeNull();
  });

  it('says why a running job has no estimate, on its own card', () => {
    renderGrid([
      { job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(null, { reason: 'auto: history: needs 3 usable runs, has 1' }) },
      { job: JOB('b', 'Beta'), runHistory: RUNNING, progress: estimate(0.5) },
    ]);

    expect(cardOf('Alpha').querySelector('[data-progress-state="none"]')!.textContent).toContain('needs 3 usable runs, has 1');
    expect(cardOf('Beta').querySelector('[data-progress-state="none"]')).toBeNull();
  });
});
