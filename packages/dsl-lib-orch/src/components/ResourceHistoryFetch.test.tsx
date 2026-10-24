import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrchUiConfig } from '../runtime-config.js';
import type { ResourceHistory as ResourceHistoryData, ResourceHistoryRun } from '../types.js';
import { ResourceHistory } from './ResourceHistory.js';

// The loading side of ResourceHistory: refetch on a new job, a late answer never shown for the wrong job, the wording
// of each refusal, the pressed state of the range chips and the encoding of the job id. No timers: every answer is
// released by the test.
const T0 = Date.parse('2026-10-18T09:00:00.000Z');

function run(i: number): ResourceHistoryRun {
  return {
    startedAt: new Date(T0 + i * 3_600_000).toISOString(),
    finishedAt: new Date(T0 + i * 3_600_000 + 60_000).toISOString(),
    durationMs: 60_000, exitCode: 0, peakCpuPct: 40 + i, peakRamMb: 400 + i, avgCpuPct: 20, avgRamMb: 200, samples: 30,
    soft: { cpuPct: 60, ramMb: 600 }, hard: { cpuPct: 120, ramMb: 1200 }, enforce: 'kill',
  };
}

function history(count: number): ResourceHistoryData {
  return { runs: Array.from({ length: count }, (_, i) => run(count - 1 - i)), total: count, retention: 500 };
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

/** A fetch whose answers are released by hand, in any order. */
function deferred(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolve: (r: Response) => void = () => {};
  const promise = new Promise<Response>((r) => { resolve = r; });
  return { promise, resolve };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetOrchUiConfig();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetOrchUiConfig();
});

describe('ResourceHistory loading', () => {
  it('goes back to loading and asks again when the job changes', async () => {
    fetchMock.mockImplementation(async () => reply(history(3)));
    const { rerender } = render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    const second = deferred();
    fetchMock.mockReturnValueOnce(second.promise);
    rerender(<ResourceHistory jobId="j2" />);

    expect(await screen.findByRole('status')).toHaveTextContent('Loading resource history...');
    expect(screen.queryByRole('img')).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith('/api/jobs/j2/resource-history?limit=100');

    await act(async () => { second.resolve(reply(history(2))); });
    expect(await screen.findByText(/2 of 2 runs shown/)).toBeInTheDocument();
  });

  it('never shows the late answer of the previous job over the current one', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<ResourceHistory jobId="j1" />);
    rerender(<ResourceHistory jobId="j2" />);

    await act(async () => { second.resolve(reply(history(3))); });
    expect(await screen.findByText(/3 of 3 runs shown/)).toBeInTheDocument();
    await act(async () => { first.resolve(reply(history(5))); });

    expect(screen.getByText(/3 of 3 runs shown/)).toBeInTheDocument();
    expect(screen.queryByText(/5 of 5 runs shown/)).toBeNull();
  });

  it('never shows the late failure of the previous job over the current one', async () => {
    const first = deferred();
    const second = deferred();
    fetchMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<ResourceHistory jobId="j1" />);
    rerender(<ResourceHistory jobId="j2" />);

    await act(async () => { second.resolve(reply(history(3))); });
    await screen.findByText(/3 of 3 runs shown/);
    await act(async () => { first.resolve(reply({ error: 'boom' }, 500)); });

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(/3 of 3 runs shown/)).toBeInTheDocument();
  });

  it('does nothing, and complains about nothing, when it is unmounted before the answer arrives', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { unmount, container } = render(<ResourceHistory jobId="j1" />);

    unmount();
    await act(async () => { pending.resolve(reply(history(3))); });

    expect(container).toBeEmptyDOMElement();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('does nothing either when the unmounted request fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pending = deferred();
    fetchMock.mockReturnValueOnce(pending.promise);
    const { unmount, container } = render(<ResourceHistory jobId="j1" />);

    unmount();
    await act(async () => { pending.resolve(reply({ error: 'x' }, 500)); });

    expect(container).toBeEmptyDOMElement();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('encodes a job id that is not URL-safe', async () => {
    fetchMock.mockImplementation(async () => reply(history(1)));

    render(<ResourceHistory jobId="a b/c?d#e" />);
    await screen.findByRole('img');

    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/a%20b%2Fc%3Fd%23e/resource-history?limit=100');
  });
});

describe('ResourceHistory refusals', () => {
  it('adds the server detail to the unknown-job sentence', async () => {
    fetchMock.mockImplementation(async () => reply({ error: 'Job not found: "ghost"' }, 404));

    render(<ResourceHistory jobId="ghost" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no job "ghost" to read a resource history for (Job not found: "ghost"). It may have been removed: go back to the jobs list.');
  });

  it('keeps the unknown-job sentence whole when the 404 body is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('<html>Not Found</html>', { status: 404 }));

    render(<ResourceHistory jobId="ghost" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no job "ghost" to read a resource history for. It may have been removed: go back to the jobs list.');
  });

  it('keeps the unknown-job sentence whole when the 404 body has no error field', async () => {
    fetchMock.mockImplementation(async () => reply({}, 404));

    render(<ResourceHistory jobId="ghost" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('There is no job "ghost" to read a resource history for. It may');
  });

  it('names the status and the detail of any other failure, and where to look', async () => {
    fetchMock.mockImplementation(async () => reply({ error: 'disk full' }, 500));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The server answered HTTP 500 (disk full) when asked for the resource history. Check "orch logs"');
  });

  it('names the status alone when the failure body is not JSON', async () => {
    fetchMock.mockImplementation(async () => new Response('Bad Gateway', { status: 502 }));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('The server answered HTTP 502 when asked for the resource history. Check "orch logs"');
  });

  it('says to start the daemon on 503, whatever the body', async () => {
    fetchMock.mockImplementation(async () => new Response('whatever', { status: 503 }));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Start it with "orch start", then reload this page.');
  });

  it('says the answer is unexpected when the runs are not a list', async () => {
    fetchMock.mockImplementation(async () => reply({ runs: 'many', total: 1, retention: 500 }));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected answer');
  });

  it('says the answer is unexpected when it is JSON null', async () => {
    fetchMock.mockImplementation(async () => reply(null));

    render(<ResourceHistory jobId="j1" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected answer');
  });
});

describe('ResourceHistory range chips', () => {
  const pressed = (name: string): string | null => screen.getByRole('button', { name }).getAttribute('aria-pressed');

  it('presses only the chosen range, and moves the press with the choice', async () => {
    fetchMock.mockImplementation(async () => reply(history(3)));
    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    expect(['Last 20', 'Last 50', 'Last 100', 'All retained'].map(pressed)).toEqual(['false', 'false', 'true', 'false']);

    fireEvent.click(screen.getByRole('button', { name: 'Last 20' }));

    expect(['Last 20', 'Last 50', 'Last 100', 'All retained'].map(pressed)).toEqual(['true', 'false', 'false', 'false']);
  });

  it('asks again when going back from "all retained", with the default limit', async () => {
    fetchMock.mockImplementation(async () => reply(history(3)));
    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    fireEvent.click(screen.getByRole('button', { name: 'All retained' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: 'Last 50' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.map(c => String(c[0]).split('?')[1])).toEqual(['limit=100', 'limit=500', 'limit=100']);
    expect(pressed('Last 50')).toBe('true');
  });

  it('does not ask again between two ranges that fit the loaded runs', async () => {
    fetchMock.mockImplementation(async () => reply(history(3)));
    render(<ResourceHistory jobId="j1" />);
    await screen.findByRole('img');

    fireEvent.click(screen.getByRole('button', { name: 'Last 20' }));
    fireEvent.click(screen.getByRole('button', { name: 'Last 50' }));
    fireEvent.click(screen.getByRole('button', { name: 'Last 100' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
