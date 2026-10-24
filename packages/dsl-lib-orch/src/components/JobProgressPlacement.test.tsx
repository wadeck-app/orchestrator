import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCard } from './JobCard.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, ProgressEstimate, RuntimeEntry } from '../types.js';

const JOB: Job = { id: 'j1', type: 'cron', label: 'Job A', command: 'node a.js', enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *' };
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 77 }];
const DONE: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:05:00Z', exitCode: 0, pid: 77 }];

function estimate(): ProgressEstimate {
  const now = Date.now();
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
    expect(el!.textContent).toMatch(/4\d%|42%/);
    expect(el!.textContent).toMatch(/ends ~\d\d:\d\d/);
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
