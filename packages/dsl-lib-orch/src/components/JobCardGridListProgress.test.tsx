import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { JobCardGrid } from './JobCardGrid.js';
import type { Job, ProgressEstimate, RuntimeEntry } from '../types.js';

// List view: a running job gets a Progress and an ETA column. The clock is frozen at the daemon's "now"
// (fake timers, setSystemTime), so the percentages and the countdown are exact, never racing a real clock.
const NOW = Date.parse('2026-10-20T14:00:00.000Z');
const ETA = '2026-10-20T14:10:00.000Z';

beforeEach(() => {
  localStorage.setItem('orch-view-mode', 'list');
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const JOB = (id: string, label: string): Job => ({
  id, type: 'cron', label, command: 'echo hi', schedule: '0 * * * *', enabled: true, triggerMode: 'fire-and-forget',
});
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-10-20T13:55:00Z', exitCode: null, pid: 7 }];
const DONE: RuntimeEntry[] = [{ startedAt: '2026-10-20T13:00:00Z', finishedAt: '2026-10-20T13:05:00Z', exitCode: 0, pid: 7 }];

function estimate(progress: number | null, over: Partial<ProgressEstimate> = {}): ProgressEstimate {
  return {
    strategyId: 'history', progress, etaAt: progress === null ? null : ETA,
    confidence: progress === null ? 'none' : 'high', confidenceScore: 0.9,
    reason: 'auto: history', serverNow: new Date(NOW).toISOString(), ...over,
  };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function renderList(items: React.ComponentProps<typeof JobCardGrid>['items']) {
  return render(<MemoryRouter><JobCardGrid items={items} /></MemoryRouter>);
}

function rowOf(label: string): HTMLElement {
  return screen.getByText(label).closest('tr') as HTMLElement;
}

/** The cell under the header named `header`, of the row of `label`. */
function cell(label: string, header: string): HTMLElement {
  const headers = Array.from(document.querySelectorAll('thead th')).map(th => th.textContent);
  const index = headers.indexOf(header);
  if (index < 0) {
    throw new Error(`No "${header}" column in [${headers.join(', ')}]`);
  }
  return rowOf(label).querySelectorAll('td')[index] as HTMLElement;
}

describe('JobCardGrid list view columns', () => {
  it('has a Progress and an ETA column, between Last run and Actions', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: DONE }]);

    const headers = Array.from(document.querySelectorAll('thead th')).map(th => th.textContent);
    expect(headers).toEqual(['', 'Job', 'Type', 'Schedule', 'Status', 'Last run', 'Progress', 'ETA', 'Actions']);
  });
});

describe('JobCardGrid list view progress', () => {
  it('shows the bar with its percentage, and the end time with the time left, of a running job', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.4) }]);

    const bar = cell('Alpha', 'Progress');
    expect(bar.querySelector('[role="progressbar"]')).not.toBeNull();
    // 40 % at the daemon's now: the frozen clock has not moved the bar.
    expect(bar.textContent).toContain('40%');
    const eta = cell('Alpha', 'ETA');
    expect(eta.textContent).toBe(`ends ~${hhmm(ETA)} (in 10 min)`);
    expect(eta.textContent).not.toContain('low confidence');
  });

  it('counts the time left down and moves the bar every second, without a new poll', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.4) }]);

    // Half-way between now and the end time: 5 of the 10 minutes.
    act(() => { vi.advanceTimersByTime(5 * 60_000); });

    expect(cell('Alpha', 'ETA').textContent).toContain('in 5 min');
    // 40 % + (99 % - 40 %) * 0.5 = 69.5 % -> 70
    expect(cell('Alpha', 'Progress').textContent).toContain('70%');
  });

  it('follows the daemon clock, not this machine clock, when they differ', () => {
    // The machine is 4 minutes ahead of the daemon: the countdown must still be the daemon's 10 minutes.
    vi.setSystemTime(NOW + 4 * 60_000);
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.4) }]);

    expect(cell('Alpha', 'ETA').textContent).toContain('in 10 min');
    expect(cell('Alpha', 'Progress').textContent).toContain('40%');
  });

  it('fades a low-confidence estimate and says so in the tooltip, in both cells', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.4, { confidence: 'low' }) }]);

    for (const header of ['Progress', 'ETA']) {
      const root = cell('Alpha', header).querySelector('[data-confidence="low"]')!;
      expect(root, header).not.toBeNull();
      expect(root.getAttribute('class')).toContain('opacity-60');
      expect(root.getAttribute('title')).toContain('low confidence');
    }
  });

  it('shows the reason, muted with a tooltip, in the ETA cell and a dash in the Progress cell when there is no estimate', () => {
    const reason = 'auto: history: needs 3 usable runs, has 1';
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(null, { reason }) }]);

    const why = cell('Alpha', 'ETA').querySelector('[data-progress-state="none"]')!;
    expect(why.textContent).toBe(reason);
    expect(why.getAttribute('title')).toBe(reason);
    expect(why.getAttribute('class')).toContain('text-muted');
    expect(cell('Alpha', 'Progress').querySelector('[role="progressbar"]')).toBeNull();
    expect(cell('Alpha', 'Progress').textContent).toBe('-');
  });

  it('shows the reason of an overdue run in the ETA cell, next to its bar', () => {
    const reason = 'past the expected duration';
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.9, { etaAt: null, reason }) }]);

    expect(cell('Alpha', 'Progress').textContent).toContain('90%');
    expect(cell('Alpha', 'ETA').textContent).toBe(reason);
  });

  it('shows dashes for an idle job, even with an estimate', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: DONE, progress: estimate(0.5) }]);

    expect(cell('Alpha', 'Progress').textContent).toBe('-');
    expect(cell('Alpha', 'ETA').textContent).toBe('-');
    expect(rowOf('Alpha').querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows dashes for a running job whose first poll has no estimate yet', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: RUNNING }]);

    expect(cell('Alpha', 'Progress').textContent).toBe('-');
    expect(cell('Alpha', 'ETA').textContent).toBe('-');
  });

  it('puts each estimate on the row of its own job', () => {
    renderList([
      { job: JOB('a', 'Alpha'), runHistory: RUNNING, progress: estimate(0.25) },
      { job: JOB('b', 'Beta'), runHistory: RUNNING, progress: estimate(0.75) },
    ]);

    expect(cell('Alpha', 'Progress').textContent).toContain('25%');
    expect(cell('Beta', 'Progress').textContent).toContain('75%');
  });
});

describe('JobCardGrid list view layout', () => {
  it('pushes the Actions buttons to the right edge of their cell, in a cell as narrow as the buttons', () => {
    renderList([{ job: JOB('a', 'Alpha'), runHistory: DONE }]);

    const actions = cell('Alpha', 'Actions');
    const wrapper = actions.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain('justify-end');
    expect(wrapper.className).toContain('ml-auto');
    // A fixed width (DataTable sets it in px from the column's width), so the spare room of the table goes to
    // the other columns instead of widening this one into dead space on the right of the buttons.
    expect(actions.style.width).not.toBe('');
  });

  it('truncates a long job name with the full name as its tooltip, in a fixed-width cell', () => {
    const long = 'A job whose name is much too long for the narrow Job column of the list view';
    renderList([{ job: JOB('a', long), runHistory: DONE }]);

    const name = cell(long, 'Job');
    const text = screen.getByText(long);
    expect(text.className).toContain('truncate');
    // Cut at the column's own edge: no max-width class (a rem cap narrower than the column leaves room unused), and a
    // width that is the column's minus the 24 px of cell padding. A max-width or 100 % would be ignored by the auto
    // table layout, which widens the column to the longest name instead.
    expect(text.className).not.toMatch(/max-w-/);
    expect(parseInt(text.style.width, 10)).toBe(parseInt(name.style.width, 10) - 24);
    expect(text.getAttribute('title')).toBe(long);
    expect(name.style.width).not.toBe('');
  });
});
