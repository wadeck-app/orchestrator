import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextFireCountdown } from './NextFireCountdown.js';
import type { Job } from '../types.js';

/*
 * Two gaps this closes.
 *
 * The active window was invisible. The daemon, the form and `orch timers` all carry it, and a cron job
 * whose window has not opened yet is enabled and correctly doing nothing -- but the card showed the
 * same "every day at 03:00" as a job that fires tonight, so "starts Monday" and "running now" looked
 * identical.
 *
 * And a once job returned the bare word "Once", which only repeated the type badge beside it and threw
 * away the one fact that matters: whether its moment is ahead or behind. The CLI already says "in 3h" /
 * "overdue by 5m" (onceScheduleDisplay); this is the same wording.
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

const CRON: Job = {
  id: 'nightly', type: 'cron', label: 'Nightly', command: 'echo tick',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *',
};
const ONCE: Job = {
  id: 'deploy', type: 'once', label: 'Deploy', command: 'echo go',
  enabled: true, triggerMode: 'fire-and-forget',
  delayMs: 3 * HOUR, scheduledAt: new Date(NOW).toISOString(),
};

describe('startup jobs', () => {
  it('still say when they run', () => {
    render(<NextFireCountdown job={{ ...CRON, type: 'startup', schedule: undefined }} />);
    expect(screen.getByText('On startup')).toBeInTheDocument();
  });
});

describe('a cron job with an active window', () => {
  it('says when the window opens, instead of a schedule that is not in force yet', () => {
    render(<NextFireCountdown job={{ ...CRON, activeFrom: new Date(NOW + 3 * DAY).toISOString() }} />);
    expect(screen.getByText(/Starts in 3d/)).toBeInTheDocument();
  });

  it('says when the window closes, so "why did my job disable itself" has an answer', () => {
    render(<NextFireCountdown job={{ ...CRON, activeUntil: new Date(NOW + 5 * DAY).toISOString() }} />);
    expect(screen.getByText(/Expires in 5d/)).toBeInTheDocument();
  });

  // Expired is the state the daemon turns into "disabled", so the card must not imply it still runs.
  it('says the period has ended once the window has closed', () => {
    render(<NextFireCountdown job={{ ...CRON, activeUntil: new Date(NOW - DAY).toISOString() }} />);
    expect(screen.getByText(/ended/i)).toBeInTheDocument();
  });

  it('a job inside its window reads exactly as one with no window at all', () => {
    const withWindow = render(
      <NextFireCountdown job={{ ...CRON, activeUntil: new Date(NOW + 400 * DAY).toISOString() }} />,
    );
    const windowText = withWindow.container.textContent;
    withWindow.unmount();
    const plain = render(<NextFireCountdown job={CRON} />);
    // The far-off end is still announced, but the schedule itself must still be there.
    expect(windowText).toContain(plain.container.textContent ?? '');
  });

  it('a window with no bounds does not add a chip', () => {
    render(<NextFireCountdown job={CRON} />);
    expect(screen.queryByText(/Starts in|Expires in|ended/i)).toBeNull();
  });
});

describe('a cron job with no window', () => {
  // The expression is deliberately kept, in a tooltip, for anyone who wants to check it -- so the
  // assertion is that the phrasing is what shows, not that the expression is gone.
  it('phrases the schedule rather than asking the reader to parse cron', () => {
    render(<NextFireCountdown job={CRON} />);
    expect(screen.getByText('Daily at 03:00')).toBeInTheDocument();
    expect(screen.getByRole('tooltip')).toHaveTextContent('0 3 * * *');
  });

  it('falls back to the raw expression when it cannot be phrased truthfully', () => {
    render(<NextFireCountdown job={{ ...CRON, schedule: '*/7 2-5 1,15 */3 1-5' }} />);
    expect(screen.getByText(/\*\/7 2-5 1,15 \*\/3 1-5/)).toBeInTheDocument();
  });
});

describe('a once job', () => {
  it('counts down to its moment instead of repeating the word "Once"', () => {
    render(<NextFireCountdown job={ONCE} />);
    expect(screen.getByText('in 3h')).toBeInTheDocument();
    expect(screen.queryByText('Once')).toBeNull();
  });

  // Overdue is the state that means the daemon was down when the moment passed. Clamping it to
  // "in 0s" read as "about to fire", which is the opposite of what happened.
  it('says overdue when its moment has passed and it has not run', () => {
    render(<NextFireCountdown job={{ ...ONCE, scheduledAt: new Date(NOW - 4 * HOUR).toISOString(), delayMs: HOUR }} />);
    expect(screen.getByText('overdue by 3h')).toBeInTheDocument();
  });

  it('a spent job says when it fired, not how late it is', () => {
    render(<NextFireCountdown job={{ ...ONCE, spent: true, spentAt: new Date(NOW - 2 * DAY).toISOString() }} />);
    expect(screen.getByText(/Fired 2d ago/)).toBeInTheDocument();
    expect(screen.queryByText(/overdue/i)).toBeNull();
  });

  // A once job created before scheduledAt existed cannot be placed in time at all. Saying so beats
  // rendering "in NaNs".
  it('says unscheduled when it cannot be placed in time', () => {
    render(<NextFireCountdown job={{ ...ONCE, scheduledAt: undefined }} />);
    expect(screen.getByText('unscheduled')).toBeInTheDocument();
  });
});
