import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JobProgress, formatEndTime, formatRemaining } from './JobProgress.js';
import type { ProgressEstimate } from '../types.js';

const SERVER_NOW = Date.parse('2026-10-20T14:00:00.000Z');
const ETA = '2026-10-20T14:06:00.000Z';

function estimate(over: Partial<ProgressEstimate> = {}): ProgressEstimate {
  return {
    strategyId: 'history', progress: 0.42, etaAt: ETA, confidence: 'high', confidenceScore: 0.9,
    reason: 'auto: history (median of the last 8 usable runs: 10 min)', serverNow: new Date(SERVER_NOW).toISOString(), ...over,
  };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('JobProgress states', () => {
  it('shows the percent, the end time and the time left for an estimate', () => {
    const { container } = render(<JobProgress progress={estimate()} nowMs={SERVER_NOW} />);

    const root = container.querySelector('[data-progress-state="estimate"]');
    expect(root).not.toBeNull();
    expect(root!.textContent).toContain('42%');
    expect(root!.textContent).toContain(`ends ~${hhmm(ETA)}`);
    expect(root!.textContent).toContain('in 6 min');
    expect(root!.getAttribute('data-confidence')).toBe('high');
  });

  it('marks a low-confidence estimate in the text and the style, and still shows it', () => {
    const { container } = render(<JobProgress progress={estimate({ confidence: 'low' })} nowMs={SERVER_NOW} />);

    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.getAttribute('data-confidence')).toBe('low');
    expect(root.textContent).toContain(`ends ~${hhmm(ETA)}`);
    expect(root.textContent).toContain('low confidence');
    expect(root.getAttribute('class')).toContain('opacity-');
  });

  it('shows the reason, muted and without a bar, when there is no estimate', () => {
    const reason = 'auto: history: needs 3 usable runs, has 1 (progress appears after 2 more run(s) that end with exit code 0)';
    const { container } = render(
      <JobProgress progress={estimate({ progress: null, etaAt: null, confidence: 'none', reason })} nowMs={SERVER_NOW} />,
    );

    const root = container.querySelector('[data-progress-state="none"]')!;
    expect(root.textContent).toContain(reason);
    expect(root.getAttribute('class')).toContain('text-muted');
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows the reason when the daemon could not compute progress', () => {
    const reason = 'progress unavailable: Unknown command: get-progress. Check: orch logs';
    render(
      <JobProgress progress={estimate({ strategyId: null, progress: null, etaAt: null, confidence: 'none', reason })} nowMs={SERVER_NOW} />,
    );
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it('says the run is longer than usual instead of a negative time, keeping the bar at 99%', () => {
    const { container } = render(
      <JobProgress
        progress={estimate({ progress: 0.99, etaAt: null, reason: 'longer than usual (usual: 10 min)' })}
        nowMs={SERVER_NOW}
      />,
    );

    const root = container.querySelector('[data-progress-state="overdue"]')!;
    expect(root.textContent).toContain('99%');
    expect(root.textContent).toContain('longer than usual (usual: 10 min)');
    expect(root.textContent).not.toMatch(/-\d/);
    expect(root.textContent).not.toContain('ends');
  });

  it('says it ends any moment when the end time has passed before the next poll', () => {
    const { container } = render(<JobProgress progress={estimate()} nowMs={SERVER_NOW + 10 * 60_000} />);
    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.textContent).toContain('any moment now');
    expect(root.textContent).not.toMatch(/in -/);
    expect(root.textContent).toContain('99%');
  });

  it('moves the percentage forward between polls, never past 99%', () => {
    const { container } = render(<JobProgress progress={estimate()} nowMs={SERVER_NOW + 3 * 60_000} />);
    const pct = Number(/(\d+)%/.exec(container.textContent!)![1]);
    expect(pct).toBeGreaterThan(42);
    expect(pct).toBeLessThanOrEqual(99);
  });

  it('renders nothing when there is no estimate object at all', () => {
    const { container } = render(<JobProgress progress={null} nowMs={SERVER_NOW} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('formatting', () => {
  it('formats the remaining time', () => {
    expect(formatRemaining(30_000)).toBe('in <1 min');
    expect(formatRemaining(6 * 60_000)).toBe('in 6 min');
    expect(formatRemaining(125 * 60_000)).toBe('in 2 h 05 min');
    expect(formatRemaining(0)).toBe('any moment now');
    expect(formatRemaining(-5000)).toBe('any moment now');
  });

  it('formats the end time as local HH:MM, with the date when it is not today', () => {
    const now = Date.parse('2026-10-20T14:00:00.000Z');
    expect(formatEndTime(ETA, now)).toBe(hhmm(ETA));
    expect(formatEndTime('2026-10-22T14:06:00.000Z', now)).toMatch(/^\d\d-\d\d \d\d:\d\d$/);
  });
});
