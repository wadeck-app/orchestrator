import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobCard } from './JobCard.js';
import { JobProgress } from './JobProgress.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, ProgressEstimate, RuntimeEntry } from '../types.js';

const JOB: Job = { id: 'j1', type: 'cron', label: 'Job A', command: 'node a.js', enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *' };
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 77 }];
const DONE: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:05:00Z', exitCode: 0, pid: 77 }];

// The component re-reads the clock: it is frozen at the daemon's "now" so the percentage is exactly the estimate's.
const NOW = Date.parse('2026-09-02T10:30:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

function estimate(): ProgressEstimate {
  const now = NOW;
  return {
    strategyId: 'history', progress: 0.42, etaAt: new Date(now + 6 * 60_000).toISOString(), confidence: 'high', confidenceScore: 0.9,
    reason: 'auto: history', serverNow: new Date(now).toISOString(),
  };
}

describe('progress on the running banner', () => {
  it('shows the progress of a running job', () => {
    const { container } = render(<MemoryRouter><RunningBannerDetail job={JOB} jobId="j1" runHistory={RUNNING} progress={estimate()} /></MemoryRouter>);
    expect(container.querySelector('[data-progress-state="estimate"]')).not.toBeNull();
  });

  it('shows nothing when the job is not running, even if an estimate is handed in', () => {
    const { container } = render(<MemoryRouter><RunningBannerDetail job={JOB} jobId="j1" runHistory={DONE} progress={estimate()} /></MemoryRouter>);
    expect(container.querySelector('[data-progress-state]')).toBeNull();
  });

  it('shows nothing without an estimate', () => {
    const { container } = render(<MemoryRouter><RunningBannerDetail job={JOB} jobId="j1" runHistory={RUNNING} /></MemoryRouter>);
    expect(container.querySelector('[data-progress-state]')).toBeNull();
  });
});

describe('progress on the job card', () => {
  const card = (runHistory: RuntimeEntry[], progress?: ProgressEstimate | null) => render(
    <MemoryRouter><JobCard job={JOB} runHistory={runHistory} progress={progress} onTrigger={vi.fn()} onToggle={vi.fn()} /></MemoryRouter>,
  );

  it('shows the progress of a running job', () => {
    expect(card(RUNNING, estimate()).container.querySelector('[data-progress-state="estimate"]')).not.toBeNull();
  });

  it('shows the reason when there is no estimate', () => {
    const none: ProgressEstimate = { ...estimate(), progress: null, etaAt: null, confidence: 'none', reason: 'auto: history: needs 3 usable runs, has 0' };
    expect(card(RUNNING, none).container.querySelector('[data-progress-state="none"]')!.textContent).toContain('needs 3 usable runs, has 0');
  });

  it('shows nothing for a job that is not running', () => {
    expect(card(DONE, estimate()).container.querySelector('[data-progress-state]')).toBeNull();
  });
});

const NONE: ProgressEstimate = { ...estimate(), progress: null, etaAt: null, confidence: 'none', reason: 'auto: history: needs 3 usable runs, has 0' };

describe.each([
  ['alert (design b)', (runHistory: RuntimeEntry[], progress?: ProgressEstimate | null) => <RunningAlertDetail job={JOB} jobId="j1" runHistory={runHistory} progress={progress} />],
  ['inline (design c)', (runHistory: RuntimeEntry[], progress?: ProgressEstimate | null) => <RunningInlineDetail job={JOB} jobId="j1" runHistory={runHistory} progress={progress} />],
])('progress on the %s running view', (_name, view) => {
  const show = (runHistory: RuntimeEntry[], progress?: ProgressEstimate | null) => render(<MemoryRouter>{view(runHistory, progress)}</MemoryRouter>);

  it('shows the percentage and the end time of a running job', () => {
    const { container } = show(RUNNING, estimate());
    const el = container.querySelector('[data-progress-state="estimate"]');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('42%');
    expect(el!.textContent).toMatch(/ends ~\d\d:\d\d \(in 6 min\)/);
  });

  it('shows the reason when there is no estimate', () => {
    const { container } = show(RUNNING, NONE);
    expect(container.querySelector('[data-progress-state="none"]')!.textContent).toContain('needs 3 usable runs, has 0');
  });

  it('shows nothing extra for a null or absent progress', () => {
    expect(show(RUNNING, null).container.querySelector('[data-progress-state]')).toBeNull();
    expect(show(RUNNING).container.querySelector('[data-progress-state]')).toBeNull();
  });

  it('shows nothing when the job is not running', () => {
    expect(show(DONE, estimate()).container.querySelector('[data-progress-state]')).toBeNull();
  });
});

describe('progress row of the job card', () => {
  const card = (runHistory: RuntimeEntry[], progress?: ProgressEstimate | null, uptimePercent: number | null = 90) => render(
    <MemoryRouter><JobCard job={JOB} runHistory={runHistory} progress={progress} uptimePercent={uptimePercent} onTrigger={vi.fn()} onToggle={vi.fn()} /></MemoryRouter>,
  );
  const lastRun = (c: HTMLElement): Element => [...c.querySelectorAll('p')].find(p => p.textContent?.startsWith('Last run'))!;

  it('puts the progress of a running job on a row of its own, under the status line and above the last run', () => {
    const { container } = card(RUNNING, estimate());
    const row = container.querySelector('[data-job-progress-row]')!;
    expect(row).not.toBeNull();
    expect(row.querySelector('[data-progress-state="estimate"]')).not.toBeNull();
    // the uptime bar keeps its own row
    expect(row.textContent).not.toContain('uptime');
    expect(row.contains(container.querySelector('[role="progressbar"]:not([aria-valuenow="42"])'))).toBe(false);
    expect(row.compareDocumentPosition(lastRun(container)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('draws the progress on the full card width and truncates its text', () => {
    const { container } = card(RUNNING, estimate());
    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.getAttribute('class')).toContain('w-full');
    expect(root.getAttribute('class')).toContain('min-w-0');
    const text = root.querySelector('[data-progress-detail]')!;
    expect(text.getAttribute('class')).toContain('truncate');
    expect(text.getAttribute('title')).toMatch(/^ends ~\d\d:\d\d \(in 6 min\)$/);
  });

  it('truncates the reason of a missing estimate too', () => {
    const { container } = card(RUNNING, NONE);
    const el = container.querySelector('[data-job-progress-row] [data-progress-state="none"]')!;
    expect(el.getAttribute('class')).toContain('truncate');
    expect(el.getAttribute('title')).toBe(NONE.reason);
  });

  it('adds no row to a card that is not running', () => {
    expect(card(DONE, estimate()).container.querySelector('[data-job-progress-row]')).toBeNull();
    expect(card(RUNNING, null).container.querySelector('[data-job-progress-row]')).toBeNull();
  });

  it('leaves the other placements as they were: no fill, no title', () => {
    const { container } = render(<JobProgress progress={estimate()} nowMs={NOW} />);
    const root = container.querySelector('[data-progress-state="estimate"]')!;
    expect(root.getAttribute('class')).not.toContain('w-full');
    expect(root.querySelector('[data-progress-detail]')!.hasAttribute('title')).toBe(false);
  });
});

describe('track of the bars of the job card', () => {
  it('paints the uptime track with the progress-track token, like the progress bar', () => {
    const { container } = render(
      <MemoryRouter><JobCard job={JOB} runHistory={DONE} uptimePercent={87.5} onTrigger={vi.fn()} onToggle={vi.fn()} /></MemoryRouter>,
    );
    const bar = container.querySelector('[role="progressbar"]')!;
    expect(bar.closest('[class*="bg-progress-track"]')).not.toBeNull();
  });
});
