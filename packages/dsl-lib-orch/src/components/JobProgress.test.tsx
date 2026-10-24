import React from 'react';
import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('JobProgress ticking (nowMs omitted, fake clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(SERVER_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const text = (container: HTMLElement) => container.querySelector('[data-progress-state]')!.textContent!;
  const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

  it('moves the bar and the remaining time forward every second', () => {
    const { container } = render(<JobProgress progress={estimate()} />);
    expect(text(container)).toContain('42%');
    expect(text(container)).toContain('in 6 min');

    // 36 s of 360 s: 0.42 + 0.57 * 0.1 = 47.7 %
    advance(36_000);
    expect(text(container)).toContain('48%');

    // 90 s: 0.42 + 0.57 * 0.25 = 56.25 %
    advance(54_000);
    expect(text(container)).toContain('56%');
    expect(text(container)).toContain('in 5 min');

    // past the end time, capped
    advance(10 * 60_000);
    expect(text(container)).toContain('99%');
    expect(text(container)).toContain('any moment now');
  });

  it('does not move before a full second has elapsed', () => {
    const { container } = render(<JobProgress progress={estimate()} />);
    advance(999);
    expect(text(container)).toContain('42%');
    expect(text(container)).toContain('in 6 min');
  });

  it('clears its interval on unmount', () => {
    const baseline = vi.getTimerCount();
    const { unmount } = render(<JobProgress progress={estimate()} />);
    expect(vi.getTimerCount()).toBeGreaterThan(baseline);

    unmount();

    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('stops its interval when the estimate becomes an overdue one without end time', () => {
    const baseline = vi.getTimerCount();
    const { rerender } = render(<JobProgress progress={estimate()} />);
    expect(vi.getTimerCount()).toBeGreaterThan(baseline);

    rerender(<JobProgress progress={estimate({ progress: 0.99, etaAt: null, reason: 'longer than usual' })} />);

    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('runs no interval when there is no end time', () => {
    const baseline = vi.getTimerCount();
    render(<JobProgress progress={estimate({ progress: 0.99, etaAt: null, reason: 'longer than usual' })} />);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('runs no interval when there is no estimate to count down', () => {
    const baseline = vi.getTimerCount();
    render(<JobProgress progress={estimate({ progress: null, etaAt: null, confidence: 'none', reason: 'why not' })} />);
    render(<JobProgress progress={null} />);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('runs no interval when the caller pins the time with nowMs', () => {
    const baseline = vi.getTimerCount();
    const { container } = render(<JobProgress progress={estimate()} nowMs={SERVER_NOW} />);
    expect(vi.getTimerCount()).toBe(baseline);

    advance(5 * 60_000);

    expect(text(container)).toContain('42%');
  });

  it('counts down against the daemon clock when the browser clock is 5 minutes behind', () => {
    vi.setSystemTime(SERVER_NOW - 5 * 60_000);
    const { container } = render(<JobProgress progress={estimate()} />);
    // Read as if the browser clock was right, the end would be 11 min away.
    expect(text(container)).toContain('42%');
    expect(text(container)).toContain('in 6 min');

    advance(90_000);

    expect(text(container)).toContain('56%');
  });

  it('counts down against the daemon clock when the browser clock is 5 minutes ahead', () => {
    vi.setSystemTime(SERVER_NOW + 5 * 60_000);
    const { container } = render(<JobProgress progress={estimate()} />);
    expect(text(container)).toContain('42%');
    expect(text(container)).toContain('in 6 min');
  });

  it('takes the new skew when a poll brings a new server time', () => {
    const { container, rerender } = render(<JobProgress progress={estimate()} />);
    advance(60_000);
    expect(text(container)).toContain('in 5 min');

    // the next poll: 1 min later on the daemon, with a recomputed end time 4 min away and 60 % done
    const later = new Date(SERVER_NOW + 60_000).toISOString();
    rerender(<JobProgress progress={estimate({ progress: 0.6, etaAt: '2026-10-20T14:05:00.000Z', serverNow: later })} />);

    expect(text(container)).toContain('60%');
    expect(text(container)).toContain('in 4 min');
  });

  it('does not show NaN when the daemon time cannot be parsed', () => {
    const { container } = render(<JobProgress progress={estimate({ serverNow: 'not a date' })} />);
    expect(text(container)).not.toContain('NaN');
  });

  it('is at the cap when the end time is not after the daemon time', () => {
    const atNow = render(<JobProgress progress={estimate({ etaAt: new Date(SERVER_NOW).toISOString() })} nowMs={SERVER_NOW} />);
    expect(text(atNow.container)).toContain('99%');
    expect(text(atNow.container)).toContain('any moment now');

    const before = render(<JobProgress progress={estimate({ etaAt: new Date(SERVER_NOW - 5000).toISOString() })} nowMs={SERVER_NOW} />);
    expect(text(before.container)).toContain('99%');
    expect(text(before.container)).toContain('any moment now');
  });

  it('keeps an already-capped estimate at 99%, not above', () => {
    const { container } = render(<JobProgress progress={estimate({ progress: 0.99 })} nowMs={SERVER_NOW + 3 * 60_000} />);
    expect(text(container)).toContain('99%');
  });
});

describe('JobProgress details', () => {
  it('puts the reason and the strategy in the tooltip', () => {
    render(<JobProgress progress={estimate({ reason: 'auto: history (median 10 min)', strategyId: 'history' })} nowMs={SERVER_NOW} />);
    expect(screen.getByText('auto: history (median 10 min) [strategy: history]')).toBeInTheDocument();
  });

  it('leaves the strategy out of the tooltip when there is none', () => {
    render(<JobProgress progress={estimate({ reason: 'only a reason', strategyId: null })} nowMs={SERVER_NOW} />);
    expect(screen.getByText('only a reason')).toBeInTheDocument();
  });

  it('renders a medium confidence plainly: tagged, not dimmed, no warning text', () => {
    const { container } = render(<JobProgress progress={estimate({ confidence: 'medium', confidenceScore: 0.6 })} nowMs={SERVER_NOW} />);
    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.getAttribute('data-confidence')).toBe('medium');
    expect(root.getAttribute('class')).not.toContain('opacity-');
    expect(root.textContent).not.toContain('low confidence');
    expect(root.textContent).toContain('42%');
  });

  it('renders a high confidence without the low-confidence marks', () => {
    const { container } = render(<JobProgress progress={estimate()} nowMs={SERVER_NOW} />);
    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.getAttribute('class')).not.toContain('opacity-');
    expect(root.textContent).not.toContain('low confidence');
  });
});

describe('formatting', () => {
  it('has exact boundaries around the minute and the hour', () => {
    expect(formatRemaining(1)).toBe('in <1 min');
    expect(formatRemaining(59_999)).toBe('in <1 min');
    expect(formatRemaining(60_000)).toBe('in 1 min');
    expect(formatRemaining(60_001)).toBe('in 2 min');
    expect(formatRemaining(59 * 60_000)).toBe('in 59 min');
    expect(formatRemaining(59 * 60_000 + 1)).toBe('in 1 h 00 min');
    expect(formatRemaining(60 * 60_000)).toBe('in 1 h 00 min');
    expect(formatRemaining(60 * 60_000 + 1)).toBe('in 1 h 01 min');
  });

  it('adds the date when the end is after midnight', () => {
    // local-time constructors: the result does not depend on the machine's time zone
    const now = new Date(2026, 9, 20, 23, 50).getTime();
    expect(formatEndTime(new Date(2026, 9, 21, 0, 10).toISOString(), now)).toBe('10-21 00:10');
    expect(formatEndTime(new Date(2026, 9, 20, 23, 59).toISOString(), now)).toBe('23:59');
    expect(formatEndTime(new Date(2027, 0, 1, 0, 5).toISOString(), new Date(2026, 11, 31, 23, 50).getTime())).toBe('01-01 00:05');
  });

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
