import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import type { ResourceHistory as ResourceHistoryData, ResourceHistoryRun } from '../types.js';
import { ResourceHistory } from './ResourceHistory.js';
import { runKind, stepSegments } from './ResourceHistoryChart.js';

/*
 * The daemon keeps the peak and the average of the last 500 runs of a job and nothing drew them. These tests
 * hold the chart to what a reader needs: one mark per run, oldest to newest, the limits each run was held to,
 * the runs the monitor ended told apart from the ones a person or a timeout ended, and a wording for every
 * state in which there is no chart.
 */
const T0 = Date.parse('2026-10-18T09:00:00.000Z');

function run(i: number, extra: Partial<ResourceHistoryRun> = {}): ResourceHistoryRun {
  const startedAt = new Date(T0 + i * 3_600_000).toISOString();
  return {
    startedAt,
    finishedAt: new Date(T0 + i * 3_600_000 + 60_000).toISOString(),
    durationMs: 60_000,
    exitCode: 0,
    peakCpuPct: 40 + i,
    peakRamMb: 400 + i,
    avgCpuPct: 20,
    avgRamMb: 200,
    samples: 30,
    soft: { cpuPct: 60, ramMb: 600 },
    hard: { cpuPct: 120, ramMb: 1200 },
    enforce: 'kill',
    ...extra,
  };
}

/** Newest first, as the daemon answers. */
function history(count: number, extra: { total?: number; overrides?: Record<number, Partial<ResourceHistoryRun>> } = {}): ResourceHistoryData {
  const runs = Array.from({ length: count }, (_, i) => run(count - 1 - i, extra.overrides?.[count - 1 - i]));
  return { runs, total: extra.total ?? count, retention: 500 };
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
  resetOrchUiConfig();
});

describe('ResourceHistory - what it asks for', () => {
  it('asks the module for the last 100 runs through the configured api base', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    fetchMock.mockResolvedValue(reply(history(3)));

    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(fetchMock).toHaveBeenCalledWith('/api/modules/orchestrator/api/jobs/j1/resource-history?limit=100');
  });

  it('asks again with the daemon maximum only when "all retained" is chosen', async () => {
    fetchMock.mockResolvedValue(reply(history(3)));
    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    fireEvent.click(screen.getByRole('button', { name: 'Last 50' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'All retained' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/resource-history?limit=500'));
  });
});

describe('ResourceHistory - the chart', () => {
  it('draws one peak bar per run in each panel, oldest first, and an average line', async () => {
    fetchMock.mockResolvedValue(reply(history(4)));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    for (const panel of [0, 1]) {
      const bars = [...container.querySelectorAll(`[data-testid^="bar-${panel}-"]`)];
      expect(bars).toHaveLength(4);
      // Index 0 is the oldest run: x grows with the index.
      const xs = bars.map(b => Number(b.getAttribute('x')));
      expect([...xs].sort((a, b) => a - b)).toEqual(xs);
      expect(container.querySelector(`[data-testid="avg-${panel}"]`)).not.toBeNull();
    }
  });

  it('draws the soft and hard limits as dashed step lines in both panels, each named', async () => {
    fetchMock.mockResolvedValue(reply(history(3)));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    for (const id of ['soft-0', 'soft-1', 'hard-0', 'hard-1']) {
      expect(container.querySelector(`[data-testid="${id}"]`)?.getAttribute('stroke-dasharray')).toBeTruthy();
    }
    expect(screen.getByText('hard limit')).toBeInTheDocument();
    expect(screen.getByText('soft limit')).toBeInTheDocument();
  });

  it('breaks the limit line where a run had no limit (no baseline yet) instead of drawing through it', async () => {
    fetchMock.mockResolvedValue(reply(history(4, { overrides: { 1: { soft: null, hard: null } } })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    const hard = container.querySelector('[data-testid="hard-0"]')!.getAttribute('d')!;
    expect(hard.match(/M/g)).toHaveLength(2);
  });

  it('draws a limit only in the panel whose side is defined (an absolute RAM ceiling alone, no baseline)', async () => {
    fetchMock.mockResolvedValue(reply(history(3, { overrides: { 0: { soft: null, hard: { cpuPct: null, ramMb: 512 } }, 1: { soft: null, hard: { cpuPct: null, ramMb: 512 } }, 2: { soft: null, hard: { cpuPct: null, ramMb: 512 } } } })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(container.querySelector('[data-testid="hard-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="hard-1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="soft-0"]')).toBeNull();
  });

  it('marks a run ended by the resource limit in red, a timeout or a manual kill in grey, the others in the base tone', async () => {
    fetchMock.mockResolvedValue(reply(history(4, {
      overrides: {
        1: { endReason: 'resource-limit', exitCode: null },
        2: { endReason: 'timeout', exitCode: null },
        3: { endReason: 'manual-kill', exitCode: null },
      },
    })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    const kinds = [0, 1, 2, 3].map(i => container.querySelector(`[data-testid="bar-0-${i}"]`)!.getAttribute('data-kind'));
    expect(kinds).toEqual(['normal', 'resource-limit', 'stopped', 'stopped']);
    expect(container.querySelector('[data-testid="bar-0-1"]')!.getAttribute('class')).toContain('text-danger');
    expect(container.querySelector('[data-testid="bar-0-2"]')!.getAttribute('class')).toContain('text-muted');
  });

  it('draws no bar for a run that has no measure, but keeps its place on the axis', async () => {
    fetchMock.mockResolvedValue(reply(history(3, { overrides: { 1: { peakCpuPct: null, peakRamMb: null, avgCpuPct: null, avgRamMb: null, samples: 0 } } })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(container.querySelectorAll('[data-testid^="bar-0-"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid^="hover-"]')).toHaveLength(3);
  });

  it('names the peaks and the count for a screen reader', async () => {
    fetchMock.mockResolvedValue(reply(history(3, { overrides: { 2: { endReason: 'resource-limit', exitCode: null } } })));

    render(<ResourceHistory jobId="j1" />);

    const label = (await screen.findByRole('img')).getAttribute('aria-label') ?? '';
    expect(label).toContain('3 runs');
    expect(label).toContain('peak CPU 42%');
    expect(label).toContain('peak RAM 402 MB');
    expect(label).toContain('1 ended by the resource limit');
  });

  it('labels its axes in words', async () => {
    fetchMock.mockResolvedValue(reply(history(3)));

    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(screen.getByText('CPU (%)')).toBeInTheDocument();
    expect(screen.getByText('RAM (MB)')).toBeInTheDocument();
    expect(screen.getByText('Runs, oldest to newest')).toBeInTheDocument();
  });
});

describe('ResourceHistory - hovering a run', () => {
  it('gives the date, duration, exit, end reason, peaks and averages of the run', async () => {
    fetchMock.mockResolvedValue(reply(history(3, { overrides: { 1: { endReason: 'resource-limit', exitCode: null, durationMs: 125_000 } } })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');
    fireEvent.mouseEnter(container.querySelector('[data-testid="hover-1"]')!);

    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent(new Date(T0 + 3_600_000).toLocaleString());
    expect(tip).toHaveTextContent('Duration 2m 05s');
    expect(tip).toHaveTextContent('no exit code');
    expect(tip).toHaveTextContent('stopped: over its resource budget');
    expect(tip).toHaveTextContent('Peak CPU 41%');
    expect(tip).toHaveTextContent('Average RAM 200 MB');
  });

  it('goes away when the pointer leaves', async () => {
    fetchMock.mockResolvedValue(reply(history(3)));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');
    const target = container.querySelector('[data-testid="hover-0"]')!;
    fireEvent.mouseEnter(target);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.mouseLeave(target);

    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('is reachable from the keyboard', async () => {
    fetchMock.mockResolvedValue(reply(history(3)));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');
    fireEvent.focus(container.querySelector('[data-testid="hover-2"]')!);

    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
});

describe('ResourceHistory - the range', () => {
  it('shows the 100 loaded runs by default, and says how many of how many', async () => {
    fetchMock.mockResolvedValue(reply(history(100, { total: 340 })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(container.querySelectorAll('[data-testid^="bar-0-"]')).toHaveLength(100);
    expect(screen.getByText(/100 of 340 runs shown/)).toBeInTheDocument();
    expect(screen.getByText(/keeps the last 500 runs/i)).toBeInTheDocument();
  });

  it('narrows to the newest 20 without asking again, keeping the newest runs', async () => {
    fetchMock.mockResolvedValue(reply(history(100, { total: 340 })));

    const { container } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Last 20' }));

    expect(container.querySelectorAll('[data-testid^="bar-0-"]')).toHaveLength(20);
    expect(screen.getByText(/20 of 340 runs shown/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Last 20' })).toHaveAttribute('aria-pressed', 'true');
    // The newest run (index 99, peak CPU 139) is still the last bar, so the oldest ones were dropped.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const label = screen.getByRole('img').getAttribute('aria-label') ?? '';
    expect(label).toContain('peak CPU 139%');
    expect(label).not.toContain('peak CPU 140%');
  });
});

describe('ResourceHistory - when there is no chart', () => {
  it('says it is loading before the answer', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<ResourceHistory jobId="j1" />);
    expect(screen.getByRole('status')).toHaveTextContent(/loading resource history/i);
  });

  it('says no run was measured yet, and what produces one', async () => {
    fetchMock.mockResolvedValue(reply({ runs: [], total: 0, retention: 500 }));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('status')).toHaveTextContent(/no run measured yet/i);
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('tells a stopped daemon from a failing server and from an unknown job, each with what to try', async () => {
    fetchMock.mockResolvedValueOnce(reply({ error: 'daemon-not-running' }, 503));
    const first = render(<ResourceHistory jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/orch start/);
    first.unmount();

    fetchMock.mockResolvedValueOnce(reply({ error: 'Job not found: "j1"' }, 404));
    const second = render(<ResourceHistory jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no job "j1".*Job not found/);
    second.unmount();

    fetchMock.mockResolvedValueOnce(reply({ error: 'boom' }, 500));
    render(<ResourceHistory jobId="j1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/HTTP 500 \(boom\).*orch logs/);
  });

  it('says the server cannot be reached when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not reach the dashboard server \(Failed to fetch\)/);
  });

  it('says the answer is not what was expected rather than drawing nothing', async () => {
    fetchMock.mockResolvedValue(reply({ nope: true }));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/unexpected answer.*orch cli update/i);
  });
});

describe('ResourceHistory - helpers', () => {
  it('classes a run by who ended it', () => {
    expect(runKind(run(0))).toBe('normal');
    expect(runKind(run(0, { endReason: 'resource-limit' }))).toBe('resource-limit');
    expect(runKind(run(0, { endReason: 'timeout' }))).toBe('stopped');
    expect(runKind(run(0, { endReason: 'manual-kill' }))).toBe('stopped');
  });

  it('cuts a series into runs of consecutive values, breaking at a missing one', () => {
    expect(stepSegments([1, 2, null, 3, null, null, 4, 5])).toEqual([[0, 1], [3], [6, 7]]);
    expect(stepSegments([null, null])).toEqual([]);
  });
});
