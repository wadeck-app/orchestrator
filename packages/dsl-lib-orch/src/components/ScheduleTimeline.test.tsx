import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ScheduleTimeline } from './ScheduleTimeline.js';

const FIRINGS = [{ jobId: 'nightly', label: 'Nightly', next: ['2026-12-01T03:00:00Z'] }];

const refusal = (): Response => new Response(
  JSON.stringify({ status: 'already-running', running: 1, maxConcurrency: 1 }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

describe('ScheduleTimeline Run early', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('triggers early through its own request and tells the page to reload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onAfterRunEarly = vi.fn();
    render(<ScheduleTimeline firings={FIRINGS} onAfterRunEarly={onAfterRunEarly} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run early' }));

    await waitFor(() => { expect(screen.getByRole('button')).toHaveTextContent('Triggered'); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/nightly/trigger-early', { method: 'POST' });
    expect(onAfterRunEarly).toHaveBeenCalledTimes(1);
  });

  // The server skips the scheduled occurrence only once the run started, so "Triggered" here would
  // tell the reader the 03:00 firing is covered when it is still owed.
  it('says the job is already running instead of Triggered', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(refusal()));
    render(<ScheduleTimeline firings={FIRINGS} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run early' }));

    await waitFor(() => {
      expect(screen.getByRole('button')).toHaveTextContent('Already running (1/1) - run anyway?');
    });
    expect(screen.queryByText('Triggered')).toBeNull();
  });

  it('a second click on the refusal forces the run', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => Promise.resolve(refusal()))
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    render(<ScheduleTimeline firings={FIRINGS} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run early' }));
    await userEvent.click(await screen.findByRole('button', { name: /Already running/ }));

    await waitFor(() => { expect(screen.getByRole('button')).toHaveTextContent('Triggered'); });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/jobs/nightly/trigger-early?force=true', { method: 'POST' });
  });

  it('keeps the server error reachable when the request failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'daemon-not-running' }), { status: 503 }),
    );
    render(<ScheduleTimeline firings={FIRINGS} />);

    await userEvent.click(screen.getByRole('button', { name: 'Run early' }));

    await waitFor(() => { expect(screen.getByRole('button')).toHaveTextContent('Error'); });
    expect(screen.getByRole('button')).toHaveAttribute('title', 'daemon-not-running');
  });
});
