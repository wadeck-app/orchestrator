import { describe, it, expect, vi, afterEach } from 'vitest';
import { postTrigger, postTriggerEarly } from './trigger-job.js';

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
