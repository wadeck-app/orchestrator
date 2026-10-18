import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isJobRunning, liveOrLatestRun, type Job, type RuntimeEntry } from './types.js';
import { JobCard } from './components/JobCard.js';
import { JobCardGrid } from './components/JobCardGrid.js';
import { NavBar } from './components/NavBar.js';
import { LogViewer } from './components/LogViewer.js';
import { RunningAlertDetail } from './components/RunningAlertDetail.js';
import { RunningBannerDetail } from './components/RunningBannerDetail.js';
import { RunningInlineDetail } from './components/RunningInlineDetail.js';

/*
 * A job can have several instances alive (maxConcurrency above 1, or a forced trigger). Every place
 * that asked "is it running" by reading the NEWEST run answered no as soon as that run had ended,
 * while an older instance was still going: the card said it was idle, the Kill button disappeared,
 * and "Run now" was offered for a job that had not stopped.
 */
const OLDER_STILL_RUNNING: RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 11 };
const NEWER_FINISHED: RuntimeEntry = {
  startedAt: '2026-09-02T10:05:00Z', finishedAt: '2026-09-02T10:05:30Z', exitCode: 0, pid: 12,
};
const BOTH: RuntimeEntry[] = [NEWER_FINISHED, OLDER_STILL_RUNNING];
const ALL_DONE: RuntimeEntry[] = [
  NEWER_FINISHED,
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:01:00Z', exitCode: 0, pid: 11 },
];

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget', maxConcurrency: 2,
};

describe('isJobRunning', () => {
  it('is true when any run is open, even if the newest has ended', () => {
    expect(isJobRunning(BOTH)).toBe(true);
  });

  it('is false when every run has ended', () => {
    expect(isJobRunning(ALL_DONE)).toBe(false);
  });

  it('is false with no history', () => {
    expect(isJobRunning([])).toBe(false);
    expect(isJobRunning(undefined)).toBe(false);
  });

  // The same rule isRunActive already states: a cancelled run has a null exit code and a finishedAt.
  it('does not count a cancelled run, which also has a null exit code', () => {
    const cancelled: RuntimeEntry = { ...OLDER_STILL_RUNNING, finishedAt: '2026-09-02T10:02:00Z', cancelledByUser: true };

    expect(isJobRunning([NEWER_FINISHED, cancelled])).toBe(false);
  });
});

describe('liveOrLatestRun', () => {
  it('prefers the newest run that is still open over a newer one that ended', () => {
    expect(liveOrLatestRun(BOTH)).toBe(OLDER_STILL_RUNNING);
  });

  it('takes the newest of several open runs', () => {
    const newerOpen: RuntimeEntry = { startedAt: '2026-09-02T10:03:00Z', exitCode: null, pid: 13 };

    expect(liveOrLatestRun([OLDER_STILL_RUNNING, newerOpen, NEWER_FINISHED])).toBe(newerOpen);
  });

  it('falls back to the newest run when nothing is open, as latestRun does', () => {
    expect(liveOrLatestRun(ALL_DONE)).toBe(NEWER_FINISHED);
  });

  it('is null with no history', () => {
    expect(liveOrLatestRun([])).toBeNull();
    expect(liveOrLatestRun(undefined)).toBeNull();
  });
});

describe('JobCard status', () => {
  const renderCard = (runHistory: RuntimeEntry[]) => render(
    <MemoryRouter>
      <JobCard job={JOB} runHistory={runHistory} onTrigger={vi.fn()} onToggle={vi.fn()} />
    </MemoryRouter>,
  );

  it('reads Running while an older instance is alive, although the newest run ended', () => {
    renderCard(BOTH);

    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('keeps reading as before when nothing is running', () => {
    renderCard(ALL_DONE);

    expect(screen.queryByText('Running')).toBeNull();
  });
});

describe('JobCardGrid list view status', () => {
  afterEach(() => { try { localStorage.clear(); } catch { /* not available */ } });

  it('badges the row as running while an older instance is alive', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <JobCardGrid items={[{ job: JOB, runHistory: BOTH }]} />
      </MemoryRouter>,
    );
    await user.click(screen.getByLabelText('List view'));

    // Scoped to the table: the card view is gone, so any "Running" left is the row's badge.
    expect(screen.getByRole('table')).toHaveTextContent('Running');
  });
});

describe('NavBar running counter', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('counts a job with an older instance alive, although its newest run ended', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      json: () => Promise.resolve([{ job: JOB, runHistory: BOTH }]),
    })));

    render(<MemoryRouter><NavBar /></MemoryRouter>);

    await waitFor(() => expect(screen.getByText('1 running')).toBeInTheDocument());
  });
});

describe('Running detail views', () => {
  // The inline variant prints the bare pid after a middot; the other two prefix it with "PID".
  const VARIANTS = [
    ['RunningAlertDetail', RunningAlertDetail, /PID 11/, /PID 12/],
    ['RunningBannerDetail', RunningBannerDetail, /PID 11/, /PID 12/],
    ['RunningInlineDetail', RunningInlineDetail, /\xB7\s*11$/, /\xB7\s*12$/],
  ] as const;

  describe.each(VARIANTS)('%s', (_name, Detail, livePid, finishedPid) => {
    const renderDetail = (runHistory: RuntimeEntry[]) => render(
      <MemoryRouter>
        <Detail job={JOB} jobId="j1" runHistory={runHistory} />
      </MemoryRouter>,
    );

    it('offers Kill and hides Run now while an older instance is alive', () => {
      renderDetail(BOTH);

      expect(screen.getByRole('button', { name: /kill/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
    });

    it('shows the live instance\'s pid, not the finished one\'s', () => {
      renderDetail(BOTH);

      expect(screen.getByText(livePid)).toBeInTheDocument();
      expect(screen.queryByText(finishedPid)).toBeNull();
    });

    it('offers Run now and no Kill once every run has ended', () => {
      renderDetail(ALL_DONE);

      expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /kill/i })).toBeNull();
    });
  });
});

describe('LogViewer job status', () => {
  class QuietEventSource {
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    addEventListener(): void { /* no events needed */ }
    close(): void { /* nothing to close */ }
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows Kill while an older instance is alive, although the newest run ended', async () => {
    vi.stubGlobal('EventSource', QuietEventSource);
    vi.stubGlobal('fetch', (url: string) => {
      if (url.includes('/runs')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ job: {}, runHistory: BOTH }) });
    });

    render(<MemoryRouter><LogViewer jobId="j1" /></MemoryRouter>);

    expect(await screen.findByRole('button', { name: /kill/i })).toBeInTheDocument();
    expect(await screen.findByText('Live')).toBeInTheDocument();
  });
});
