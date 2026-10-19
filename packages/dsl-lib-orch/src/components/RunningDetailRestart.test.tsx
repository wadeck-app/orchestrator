import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, RuntimeEntry } from '../types.js';

// A process that must stay up (timeoutSeconds 0) had no way to be restarted from the dashboard short of Kill then
// Run now, which is two clicks and a window where it is down with nothing saying so. Restart is one confirmed click.
const LONG_RUNNING: Job = {
  id: 'j1', type: 'startup', label: 'Job A', command: 'node server.js',
  enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 0,
};
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 77 }];
const IDLE: RuntimeEntry[] = [
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1 },
];

const VARIANTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe.each(VARIANTS)('%s Restart', (_name, Detail) => {
  afterEach(() => { vi.restoreAllMocks(); });

  function renderDetail(job: Job = LONG_RUNNING, history: RuntimeEntry[] = RUNNING, extra: { onRestart?: () => void } = {}) {
    return render(
      <MemoryRouter>
        <Detail job={job} jobId="j1" runHistory={history} {...extra} />
      </MemoryRouter>,
    );
  }

  const restartButton = () => screen.getByRole('button', { name: 'Restart' });
  async function confirm(): Promise<void> {
    await userEvent.click(restartButton());
    await userEvent.click(screen.getByRole('button', { name: 'Yes, restart' }));
  }

  it('offers Restart to a running job with no timeout', () => {
    renderDetail();
    expect(restartButton()).toBeInTheDocument();
  });

  it('offers none to a running job that has a timeout, or the default one', () => {
    renderDetail({ ...LONG_RUNNING, timeoutSeconds: 300 });
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('offers none to a job whose timeout is not set (the default is 300 s)', () => {
    const { timeoutSeconds: _unset, ...withoutTimeout } = LONG_RUNNING;
    renderDetail(withoutTimeout);
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('offers none to a long-running job that is not running (Run now is the way to start it)', () => {
    renderDetail(LONG_RUNNING, IDLE);
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('asks first, in words, and posts nothing until confirmed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderDetail();

    await userEvent.click(restartButton());

    expect(screen.getByText('Restart Job A? The running instance is ended, then started again.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts nothing when the question is cancelled', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    renderDetail();

    await userEvent.click(restartButton());
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the restart itself once confirmed and says the new pid', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(
      { id: 'j1', wasRunning: true, killed: 1, started: true, pid: 4242 },
    ));
    renderDetail();

    await confirm();

    await waitFor(() => { expect(screen.getByText(/new pid 4242/i)).toBeInTheDocument(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/restart', { method: 'POST' });
  });

  it('shows the daemon\'s refusal and its reason instead of claiming a restart', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({
      id: 'j1', wasRunning: true, killed: 1, started: false, pid: null, skipped: 'liveness',
      reason: 'the liveness check says its target is still alive. Free it, then run: orch trigger j1.',
    }));
    renderDetail();

    await confirm();

    await waitFor(() => { expect(screen.getByText(/Free it, then run: orch trigger j1/)).toBeInTheDocument(); });
    expect(screen.queryByText(/new pid/i)).toBeNull();
  });

  it('says what went wrong when the request fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'daemon-not-running' }, 503));
    renderDetail();

    await confirm();

    await waitFor(() => { expect(screen.getByText('daemon-not-running')).toBeInTheDocument(); });
  });

  it('is disabled while the call is in flight, so a double click cannot restart twice', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
    renderDetail();

    await confirm();

    await waitFor(() => { expect(restartButton()).toBeDisabled(); });
    await userEvent.click(restartButton());
    expect(screen.queryByText('Restart Job A? The running instance is ended, then started again.')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(json({ id: 'j1', wasRunning: true, killed: 1, started: true, pid: 5 }));
    await waitFor(() => { expect(screen.getByText(/new pid 5/i)).toBeInTheDocument(); });
  });

  it('hands over to a page-owned onRestart after the confirmation, without posting itself', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const onRestart = vi.fn();
    renderDetail(LONG_RUNNING, RUNNING, { onRestart });

    await userEvent.click(restartButton());
    expect(onRestart).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Yes, restart' }));

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
