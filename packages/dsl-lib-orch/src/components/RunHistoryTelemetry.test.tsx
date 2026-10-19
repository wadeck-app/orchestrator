import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { RunHistory } from './RunHistory.js';

/*
 * The history showed each run's peak CPU and RAM and left the reader to remember what is normal. The
 * daemon kills a run at 2x the average peak of the job's recent successes, so that is the line a peak
 * is held against here, and the number is given rather than only a colour. And the telemetry the daemon
 * records for every run can now be opened from the row it belongs to.
 */
const NEWEST = { startedAt: '2026-10-18T10:00:00.000Z', finishedAt: '2026-10-18T10:00:30.000Z', exitCode: 0, pid: 2, peakCpuPct: 85, peakRamMb: 150 };
const OLDER = { startedAt: '2026-10-18T09:00:00.000Z', finishedAt: '2026-10-18T09:00:30.000Z', exitCode: 0, pid: 1, peakCpuPct: 20, peakRamMb: 100 };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
const telemetry = (run: string) => ({
  run, available: true, samples: [{ t: new Date(Date.parse(run) + 2000).toISOString(), cpuPct: 5, ramMb: 50 }],
  soft: null, hard: null, truncated: false, bucketSeconds: null, rawSamples: 1,
  end: { t: new Date(Date.parse(run) + 30000).toISOString(), exitCode: 0, durationMs: 30000, reason: null },
});

let calls: string[];
function serve(baseline: unknown, baselineStatus = 200): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    calls.push(url);
    if (url.endsWith('/resource-baseline')) {
      return json(baseline, baselineStatus);
    }
    const run = new URL(url, 'http://x').searchParams.get('run') ?? '';
    return json(telemetry(run));
  }));
}

beforeEach(() => { calls = []; resetOrchUiConfig(); });
afterEach(() => { vi.unstubAllGlobals(); resetOrchUiConfig(); });

const renderHistory = (entries = [NEWEST, OLDER]) =>
  render(<MemoryRouter><RunHistory entries={entries} jobId="j1" /></MemoryRouter>);

describe('RunHistory - peaks against the budget', () => {
  it('fetches the baseline once for the whole history', async () => {
    serve({ cpuPct: 20, ramMb: 100 });
    renderHistory();
    await waitFor(() => expect(screen.getByText('85.0%').closest('span')?.getAttribute('title')).toMatch(/above/));

    expect(calls.filter(u => u.endsWith('/api/jobs/j1/resource-baseline'))).toHaveLength(1);
  });

  it('flags a peak above twice the baseline and gives the number and the budget', async () => {
    serve({ cpuPct: 20, ramMb: 100 });
    renderHistory();

    const cell = await waitFor(() => {
      const el = screen.getByText('85.0%').closest('span');
      expect(el?.getAttribute('title')).toMatch(/above/);
      return el!;
    });
    expect(cell.getAttribute('title')).toBe('Peak CPU 85.0% is above this job\'s budget of 40.0% (twice the 20.0% average peak of its recent successful runs). A run that stays over it is killed.');
    expect(within(cell).getByText(/over budget/i)).toBeInTheDocument();
  });

  it('does not flag a peak within the budget, but still gives the budget', async () => {
    serve({ cpuPct: 20, ramMb: 100 });
    renderHistory();

    await waitFor(() => expect(screen.getByText('20.0%').closest('span')?.getAttribute('title')).toMatch(/within/i));
    expect(screen.getByText('20.0%').closest('span')?.getAttribute('title')).toContain('40.0%');
    expect(screen.queryAllByText(/over budget/i)).toHaveLength(1);
  });

  it('flags a RAM peak the same way', async () => {
    serve({ cpuPct: 50, ramMb: 50 });
    renderHistory([NEWEST]);

    await waitFor(() => expect(screen.getByText('150MB').closest('span')?.getAttribute('title')).toMatch(/Peak RAM 150MB is above .* 100MB/));
  });

  it('says there is no budget yet, and does not guess one, when there is no baseline', async () => {
    serve(null);
    renderHistory([NEWEST]);

    await waitFor(() => expect(screen.getByText('85.0%').closest('span')?.getAttribute('title')).toBe('no budget yet (needs 3 measured runs)'));
    expect(screen.queryByText(/over budget/i)).toBeNull();
  });

  it('says the budget could not be loaded when the baseline request fails', async () => {
    serve({ error: 'x' }, 500);
    renderHistory([NEWEST]);

    await waitFor(() => expect(screen.getByText('85.0%').closest('span')?.getAttribute('title')).toMatch(/budget could not be loaded \(HTTP 500\)/));
  });

  it('does not ask for a baseline without a job id', () => {
    serve(null);
    render(<RunHistory entries={[NEWEST]} />);
    expect(calls).toEqual([]);
  });

  it('uses the configured api base', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    serve(null);
    renderHistory([NEWEST]);

    await waitFor(() => expect(calls).toContain('/api/modules/orchestrator/api/jobs/j1/resource-baseline'));
  });
});

describe('RunHistory - the telemetry of a run', () => {
  it('shows the chart of the latest run by default', async () => {
    serve(null);
    renderHistory();

    expect(await screen.findByRole('img')).toBeInTheDocument();
    expect(calls.some(u => u.includes('/telemetry?run=' + encodeURIComponent(NEWEST.startedAt)))).toBe(true);
    expect(calls.some(u => u.includes(encodeURIComponent(OLDER.startedAt)))).toBe(false);
  });

  it('shows the chart of another run when its Chart button is pressed', async () => {
    serve(null);
    renderHistory();
    await screen.findByRole('img');

    await userEvent.click(screen.getAllByRole('button', { name: /chart/i })[1]!);

    await waitFor(() => expect(calls.some(u => u.includes('/telemetry?run=' + encodeURIComponent(OLDER.startedAt)))).toBe(true));
    expect(screen.getAllByRole('button', { name: /chart/i })[1]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Telemetry of the run started/i)).toBeInTheDocument();
  });

  it('shows no chart and no Chart button without a job id', () => {
    serve(null);
    render(<RunHistory entries={[NEWEST]} />);
    expect(screen.queryByRole('button', { name: /chart/i })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('shows no chart for a history with no runs', () => {
    serve(null);
    render(<RunHistory entries={[]} jobId="j1" />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
