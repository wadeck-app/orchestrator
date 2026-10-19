import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { RunTelemetry, TELEMETRY_POLL_MS } from './RunTelemetry.js';
import { niceMax, formatSpan, type RunTelemetryData } from './RunTelemetryChart.js';

/*
 * The daemon records CPU and RAM of every run and nothing drew it. These tests hold the chart to what a
 * reader needs: the curves, the budgets, the kill and the end, a sentence for a screen reader, and a
 * wording for every state in which there is no chart.
 */
const RUN = '2026-10-18T09:00:00.000Z';
const at = (s: number): string => new Date(Date.parse(RUN) + s * 1000).toISOString();

function data(extra: Partial<RunTelemetryData> = {}): RunTelemetryData {
  return {
    run: RUN,
    available: true,
    samples: [
      { t: at(2), cpuPct: 10, ramMb: 100 },
      { t: at(4), cpuPct: 45.5, ramMb: 450 },
      { t: at(6), cpuPct: 20, ramMb: 300 },
    ],
    soft: null,
    hard: null,
    truncated: false,
    bucketSeconds: null,
    rawSamples: 3,
    ...extra,
  };
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetOrchUiConfig();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetOrchUiConfig();
});

describe('RunTelemetry - what it asks for', () => {
  it('asks the module for the run through the configured api base', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    fetchMock.mockResolvedValue(reply(data()));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    expect(fetchMock).toHaveBeenCalledWith(`/api/modules/orchestrator/api/jobs/j1/telemetry?run=${encodeURIComponent(RUN)}`);
  });

  it('asks for the newest run when none is given', async () => {
    fetchMock.mockResolvedValue(reply(data()));

    render(<RunTelemetry jobId="j1" />);
    await screen.findByRole('img');

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/telemetry');
  });
});

describe('RunTelemetry - the chart', () => {
  it('names the peaks and the duration for a screen reader', async () => {
    fetchMock.mockResolvedValue(reply(data({ end: { t: at(7), exitCode: 0, durationMs: 7000, reason: null } })));

    render(<RunTelemetry jobId="j1" run={RUN} />);

    const chart = await screen.findByRole('img');
    const label = chart.getAttribute('aria-label') ?? '';
    expect(label).toContain('peak CPU 45.5%');
    expect(label).toContain('peak RAM 450 MB');
    expect(label).toContain('7s');
  });

  it('draws both thresholds, in both panels, as dashed lines, each named', async () => {
    fetchMock.mockResolvedValue(reply(data({ soft: { cpuPct: 30, ramMb: 300 }, hard: { cpuPct: 60, ramMb: 600 } })));

    const { container } = render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    for (const id of ['soft-0', 'soft-1', 'hard-0', 'hard-1']) {
      expect(container.querySelector(`[data-testid="${id}"]`)?.getAttribute('stroke-dasharray')).toBeTruthy();
    }
    expect(screen.getByText('soft 30%')).toBeInTheDocument();
    expect(screen.getByText('hard 600 MB')).toBeInTheDocument();
  });

  it('says there are no budget lines, rather than drawing none silently', async () => {
    fetchMock.mockResolvedValue(reply(data()));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    expect(screen.getByText(/no budget lines/i)).toBeInTheDocument();
  });

  it('marks the moment the monitor killed the run and how the run ended', async () => {
    fetchMock.mockResolvedValue(reply(data({
      kill: { t: at(6), cpuPct: 45, ramMb: 450, consecutiveSamples: 3 },
      end: { t: at(7), exitCode: null, durationMs: 7000, reason: 'resource-limit' },
    })));

    const { container } = render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    expect(container.querySelector('[data-testid="kill-0"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="end-marker"]')).not.toBeNull();
    expect(screen.getByText('killed by the monitor')).toBeInTheDocument();
    expect(screen.getByText(/end: stopped: over its resource budget/)).toBeInTheDocument();
  });

  it('labels its axes in words', async () => {
    fetchMock.mockResolvedValue(reply(data()));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    expect(screen.getByText('Elapsed time since the run started')).toBeInTheDocument();
    expect(screen.getByText('CPU (%)')).toBeInTheDocument();
    expect(screen.getByText('RAM (MB)')).toBeInTheDocument();
  });

  it('says so when points are the highest reading of a bucket, and when the start is missing', async () => {
    fetchMock.mockResolvedValue(reply(data({ bucketSeconds: 20, rawSamples: 6000, truncated: true })));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await screen.findByRole('img');

    expect(screen.getByText(/6000 samples shown as 3 points of 20s each/)).toBeInTheDocument();
    expect(screen.getByText(/rotated out/)).toBeInTheDocument();
  });
});

describe('RunTelemetry - when there is no chart', () => {
  it('says it is loading before the answer', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<RunTelemetry jobId="j1" run={RUN} />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading telemetry/i);
  });

  it('gives the daemon\'s reason and says how long telemetry is kept', async () => {
    fetchMock.mockResolvedValue(reply(data({ available: false, samples: [], reason: 'that run has been rotated away' })));

    render(<RunTelemetry jobId="j1" run={RUN} />);

    expect(await screen.findByText(/that run has been rotated away/)).toBeInTheDocument();
    expect(screen.getByText(/kept only for the most recent samples of each job/i)).toBeInTheDocument();
  });

  it('tells a stopped daemon from a failing server, each with what to try', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'daemon-not-running' }, 503));
    const { unmount } = render(<RunTelemetry jobId="j1" run={RUN} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/orch start/);
    unmount();

    fetchMock.mockResolvedValueOnce(reply({ error: 'boom' }, 500));
    render(<RunTelemetry jobId="j1" run={RUN} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/HTTP 500 \(boom\).*orch logs/);
  });

  it('says the server cannot be reached when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<RunTelemetry jobId="j1" run={RUN} />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the dashboard server \(Failed to fetch\)/);
  });
});

describe('RunTelemetry - refreshing', () => {
  async function flush(): Promise<void> {
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('reads a finished run once, however long the page stays open', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => reply(data({ end: { t: at(7), exitCode: 0, durationMs: 7000, reason: null } })));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS * 4); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-reads a run in progress every 5 seconds', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => reply(data()));

    render(<RunTelemetry jobId="j1" run={RUN} running />);
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('takes a run with samples and no end for a run in progress when the caller does not say', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => reply(data()));

    render(<RunTelemetry jobId="j1" run={RUN} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the last reading and says the refresh failed', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(reply(data()));
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<RunTelemetry jobId="j1" run={RUN} running />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(TELEMETRY_POLL_MS); });

    expect(screen.getByRole('img')).toBeInTheDocument();
    expect(screen.getByText(/last refresh failed/i)).toBeInTheDocument();
  });
});

describe('RunTelemetry - helpers', () => {
  it('rounds an axis top to a number a person would pick', () => {
    expect(niceMax(47.3)).toBe(50);
    expect(niceMax(103)).toBe(200);
    expect(niceMax(0)).toBe(1);
  });

  it('writes durations in the largest readable unit', () => {
    expect(formatSpan(45_000)).toBe('45s');
    expect(formatSpan(750_000)).toBe('12m 30s');
    expect(formatSpan(3_900_000)).toBe('1h 05m');
  });
});
