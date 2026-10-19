import { describe, it, expect, vi, afterEach } from 'vitest';
import { postDryRun, postRestart, postTrigger, postTriggerEarly } from './trigger-job.js';

function stubFetch(response: { status: number; ok?: boolean; json?: unknown }): ReturnType<typeof vi.fn> {
  const fn = vi.fn().mockResolvedValue({
    status: response.status,
    ok: response.ok ?? (response.status >= 200 && response.status < 300),
    statusText: 'Status text',
    json: () => (response.json === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(response.json)),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('postTrigger', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('resolves with nothing when the run started (204)', async () => {
    stubFetch({ status: 204 });

    await expect(postTrigger('j1')).resolves.toBeUndefined();
  });

  it('resolves with the refusal when the job is at its limit (200)', async () => {
    const refusal = { status: 'already-running', running: 1, maxConcurrency: 1 };
    stubFetch({ status: 200, json: refusal });

    await expect(postTrigger('j1')).resolves.toEqual(refusal);
  });

  it('asks the server to force only when told to', async () => {
    const fetchFn = stubFetch({ status: 204 });

    await postTrigger('j1');
    await postTrigger('j1', { force: true });

    expect(fetchFn.mock.calls[0][0]).toBe('/api/jobs/j1/trigger');
    expect(fetchFn.mock.calls[1][0]).toBe('/api/jobs/j1/trigger?force=true');
  });

  it('honours an api base', async () => {
    const fetchFn = stubFetch({ status: 204 });

    await postTrigger('j1', undefined, 'http://localhost:1234');

    expect(fetchFn.mock.calls[0][0]).toBe('http://localhost:1234/api/jobs/j1/trigger');
  });

  // The three detail views used to ignore the status entirely, so a 503 from a stopped daemon read
  // as a successful trigger.
  it('throws the server error when the request failed', async () => {
    stubFetch({ status: 503, ok: false, json: { error: 'daemon-not-running' } });

    await expect(postTrigger('j1')).rejects.toThrow('daemon-not-running');
  });

  it('falls back to the status text when the error has no body', async () => {
    stubFetch({ status: 500, ok: false });

    await expect(postTrigger('j1')).rejects.toThrow('Status text');
  });
});

describe('postTriggerEarly', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts to trigger-early, not trigger', async () => {
    const fetchFn = stubFetch({ status: 204 });

    await expect(postTriggerEarly('nightly')).resolves.toBeUndefined();

    expect(fetchFn.mock.calls[0][0]).toBe('/api/jobs/nightly/trigger-early');
  });

  // Running early means the scheduled occurrence is skipped once it ran. The server does not skip it
  // when nothing started, and the caller has to be told so rather than shown a success.
  it('resolves with the refusal when the job is at its limit', async () => {
    const refusal = { status: 'already-running', running: 2, maxConcurrency: 2 };
    stubFetch({ status: 200, json: refusal });

    await expect(postTriggerEarly('nightly')).resolves.toEqual(refusal);
  });

  it('can force past the limit', async () => {
    const fetchFn = stubFetch({ status: 204 });

    await postTriggerEarly('nightly', { force: true });

    expect(fetchFn.mock.calls[0][0]).toBe('/api/jobs/nightly/trigger-early?force=true');
  });

  it('throws the server error when the request failed', async () => {
    stubFetch({ status: 503, ok: false, json: { error: 'daemon-not-running' } });

    await expect(postTriggerEarly('nightly')).rejects.toThrow('daemon-not-running');
  });
});

describe('postDryRun', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts to the dry-run route of the job and resolves with the daemon answer', async () => {
    const fetchFn = stubFetch({ status: 200, json: { pid: 42 } });

    await expect(postDryRun('j1')).resolves.toEqual({ pid: 42 });
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs/j1/dry-run', { method: 'POST' });
  });

  it('uses the configured api base', async () => {
    const fetchFn = stubFetch({ status: 200, json: { exitCode: 0 } });

    await postDryRun('j1', '/api/modules/orchestrator');

    expect(fetchFn.mock.calls[0][0]).toBe('/api/modules/orchestrator/api/jobs/j1/dry-run');
  });

  it('throws with the server message when the request fails', async () => {
    stubFetch({ status: 500, json: { error: 'daemon unavailable' } });

    await expect(postDryRun('j1')).rejects.toThrow('daemon unavailable');
  });

  // The daemon answers 200 with { error } when the job does not declare dryRunSupported.
  it('throws when the daemon refuses with an error body', async () => {
    stubFetch({ status: 200, json: { error: 'Job "j1" does not declare dryRunSupported: true' } });

    await expect(postDryRun('j1')).rejects.toThrow('dryRunSupported');
  });
});

describe('postRestart', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('posts to the restart route of the job and resolves with the daemon answer', async () => {
    const answer = { id: 'j1', wasRunning: true, killed: 1, started: true, pid: 42 };
    const fetchFn = stubFetch({ status: 200, json: answer });

    await expect(postRestart('j1')).resolves.toEqual(answer);
    expect(fetchFn).toHaveBeenCalledWith('/api/jobs/j1/restart', { method: 'POST' });
  });

  it('uses the configured api base', async () => {
    const fetchFn = stubFetch({ status: 200, json: { id: 'j1', wasRunning: false, killed: 0, started: true, pid: 1 } });

    await postRestart('j1', '/api/modules/orchestrator');

    expect(fetchFn.mock.calls[0][0]).toBe('/api/modules/orchestrator/api/jobs/j1/restart');
  });

  // A start the daemon refused is an answer to show (the old instance is gone), not an error to throw.
  it('resolves with a refused start, reason included', async () => {
    const answer = { id: 'j1', wasRunning: true, killed: 1, started: false, pid: null, skipped: 'liveness', reason: 'still alive' };
    stubFetch({ status: 200, json: answer });

    await expect(postRestart('j1')).resolves.toEqual(answer);
  });

  it('throws with the server message when the request fails', async () => {
    stubFetch({ status: 409, json: { error: 'Job "j1" is disabled' } });

    await expect(postRestart('j1')).rejects.toThrow('Job "j1" is disabled');
  });

  it('throws with the status text when the failure has no body', async () => {
    stubFetch({ status: 503 });

    await expect(postRestart('j1')).rejects.toThrow('Status text');
  });
});
