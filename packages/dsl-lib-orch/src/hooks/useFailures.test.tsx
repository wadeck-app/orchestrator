import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { useFailures } from './useFailures.js';

const FAILURES = [
  { jobId: 'a', jobLabel: 'Job A', entry: { startedAt: '2026-10-18T09:10:00Z', exitCode: 1, pid: 1 } },
  { jobId: 'b', jobLabel: 'Job B', entry: { startedAt: '2026-10-18T09:20:00Z', exitCode: 2, pid: 2 } },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('useFailures', () => {
  let calls: Array<{ url: string; init?: RequestInit }>;
  let ackStatus: number;

  beforeEach(() => {
    calls = [];
    ackStatus = 204;
    resetOrchUiConfig();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/api/failures/ack')) {
        return new Response(null, { status: ackStatus });
      }
      return json(FAILURES);
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetOrchUiConfig();
  });

  const ackBodies = (): unknown[] => calls
    .filter(c => c.url.endsWith('/api/failures/ack'))
    .map(c => JSON.parse(String(c.init?.body ?? '{}')));

  it('loads the failures from the configured API', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    const { result } = renderHook(() => useFailures());
    await waitFor(() => { expect(result.current.failures).toHaveLength(2); });
    expect(calls[0]?.url).toBe('/api/modules/orchestrator/api/failures');
  });

  it('acknowledges ONE job by its id and removes only that one', async () => {
    const { result } = renderHook(() => useFailures());
    await waitFor(() => { expect(result.current.failures).toHaveLength(2); });

    await act(async () => { await result.current.acknowledgeOne('a'); });

    expect(ackBodies()).toEqual([{ jobId: 'a' }]);
    expect(result.current.failures.map(f => f.jobId)).toEqual(['b']);
  });

  it('acknowledges everything without naming a job', async () => {
    const { result } = renderHook(() => useFailures());
    await waitFor(() => { expect(result.current.failures).toHaveLength(2); });

    await act(async () => { await result.current.acknowledgeAll(); });

    expect(ackBodies()).toEqual([{}]);
    expect(result.current.failures).toEqual([]);
  });

  it('keeps a failure on screen when the server did not acknowledge it', async () => {
    const { result } = renderHook(() => useFailures());
    await waitFor(() => { expect(result.current.failures).toHaveLength(2); });
    ackStatus = 503;

    await act(async () => { await result.current.acknowledgeOne('a'); });

    expect(result.current.failures.map(f => f.jobId)).toEqual(['a', 'b']);
  });
});
