import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, RuntimeEntry } from '../types.js';

// onDryRun was declared on all three detail components and POST /api/jobs/:id/dry-run was allowed, but no
// button existed: a job declaring dryRunSupported had no way to be dry-run from the dashboard.
const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget', dryRunSupported: true,
};
const IDLE: RuntimeEntry[] = [
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1 },
];

const VARIANTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

describe.each(VARIANTS)('%s Dry run', (_name, Detail) => {
  afterEach(() => { vi.restoreAllMocks(); });

  function renderDetail(job: Job = JOB, extra: { onDryRun?: () => void } = {}) {
    return render(
      <MemoryRouter>
        <Detail job={job} jobId="j1" runHistory={IDLE} {...extra} />
      </MemoryRouter>,
    );
  }

  it('offers a Dry run button only to a job that declares dryRunSupported', () => {
    renderDetail();
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeInTheDocument();
  });

  it('offers no Dry run button to a job that does not', () => {
    renderDetail({ ...JOB, dryRunSupported: false });
    expect(screen.queryByRole('button', { name: 'Dry run' })).toBeNull();
  });

  it('posts the dry run itself and says it started', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ pid: 4242 }), { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    renderDetail();

    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));

    await waitFor(() => { expect(screen.getByText(/pid 4242/i)).toBeInTheDocument(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/dry-run', { method: 'POST' });
  });

  it('says what went wrong instead of staying silent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ error: 'daemon unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } },
    ));
    renderDetail();

    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));

    await waitFor(() => { expect(screen.getByText('daemon unavailable')).toBeInTheDocument(); });
  });

  it('hands over to a page-owned onDryRun when the page declares one, without posting itself', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const onDryRun = vi.fn();
    renderDetail(JOB, { onDryRun });

    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));

    expect(onDryRun).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
