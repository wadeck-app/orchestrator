import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { NavStats } from './NavStats.js';
import type { Job, RuntimeEntry } from '../types.js';

/*
 * The "8 jobs / 1 running / 1 failed" figures of the dashboard's navbar, as a component of their own so
 * an app-core module can put them in app-core's navbar. NavBar renders this same component.
 */
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id, type: 'cron', label: id, command: 'x', schedule: '* * * * *', enabled: true, triggerMode: 'fire-and-forget', ...extra,
});
const finished = (exitCode: number): RuntimeEntry[] => [{ startedAt: '2026-10-18T09:00:00Z', finishedAt: '2026-10-18T09:01:00Z', exitCode, pid: 1 }];
const running: RuntimeEntry[] = [{ startedAt: '2026-10-18T09:00:00Z', exitCode: null, pid: 2 }];

function serve(items: Array<{ job: Job; runHistory: RuntimeEntry[] }>): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(items), { status: 200 }));
}

describe('NavStats', () => {
  beforeEach(() => { resetOrchUiConfig(); });
  afterEach(() => { vi.restoreAllMocks(); resetOrchUiConfig(); });

  it('says all is well when nothing runs and nothing failed', async () => {
    serve([{ job: job('a'), runHistory: finished(0) }, { job: job('b'), runHistory: finished(0) }]);
    render(<NavStats />);
    expect(await screen.findByText('2 jobs')).toBeInTheDocument();
    expect(screen.getByText('All OK')).toBeInTheDocument();
  });

  it('counts running and failed jobs', async () => {
    serve([
      { job: job('a'), runHistory: running },
      { job: job('b'), runHistory: finished(1) },
      { job: job('c'), runHistory: finished(0) },
    ]);
    render(<NavStats />);
    expect(await screen.findByText('3 jobs')).toBeInTheDocument();
    expect(screen.getByText('1 running')).toBeInTheDocument();
    expect(screen.getByText('1 failed')).toBeInTheDocument();
    expect(screen.queryByText('All OK')).toBeNull();
  });

  it('leaves out a once job that has already fired, so the figure agrees with the job grid', async () => {
    serve([
      { job: job('a'), runHistory: finished(0) },
      { job: job('old', { type: 'once', spent: true }), runHistory: finished(1) },
    ]);
    render(<NavStats />);
    expect(await screen.findByText('1 jobs')).toBeInTheDocument();
    expect(screen.queryByText(/failed/)).toBeNull();
  });

  it('asks the configured API, not /api', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    const fetchMock = serve([]);
    render(<NavStats />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/modules/orchestrator/api/jobs');
  });

  it('shows nothing, rather than a wrong figure, while the daemon cannot be reached', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const { container } = render(<NavStats />);
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled(); });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('NavStats refreshMs', () => {
  afterEach(() => { vi.restoreAllMocks(); resetOrchUiConfig(); });

  it('asks again at the interval it was given', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    render(<NavStats refreshMs={30} />);
    await waitFor(() => { expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3); });
  });
});
