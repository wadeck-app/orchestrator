import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, RuntimeEntry } from '../types.js';

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget',
};
// A finished run, so the job is idle and the Run now button is on screen.
const IDLE: RuntimeEntry[] = [
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1 },
];

const VARIANTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

describe.each(VARIANTS)('%s Run now', (_name, Detail) => {
  afterEach(() => { vi.restoreAllMocks(); });

  function renderDetail(onAfterTrigger?: () => void) {
    return render(
      <MemoryRouter>
        <Detail job={JOB} jobId="j1" runHistory={IDLE} onAfterTrigger={onAfterTrigger} />
      </MemoryRouter>,
    );
  }

  it('triggers through its own request and tells the page to reload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onAfterTrigger = vi.fn();
    renderDetail(onAfterTrigger);

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => { expect(onAfterTrigger).toHaveBeenCalledTimes(1); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/trigger', { method: 'POST' });
  });

  // A page-owned brain sees a status, never the 200 body, so a refusal read as a started run.
  it('shows that the job is already running instead of Triggered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ status: 'already-running', running: 1, maxConcurrency: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const onAfterTrigger = vi.fn();
    renderDetail(onAfterTrigger);

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Already running \(1\/1\)/ })).toBeInTheDocument();
    });
    expect(screen.queryByText('Triggered')).toBeNull();
    expect(onAfterTrigger).toHaveBeenCalled();
  });

  // These three used to ignore the status entirely: a 503 from a stopped daemon read as success.
  it('shows the server error when the request failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'daemon-not-running' }), { status: 503 }),
    );
    renderDetail();

    await userEvent.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => { expect(screen.getByText('daemon-not-running')).toBeInTheDocument(); });
    expect(screen.queryByText('Triggered')).toBeNull();
  });
});
