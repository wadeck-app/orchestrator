import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetcher } from './fetcher.js';

/*
 * The message this throws is what the user reads. Since brains publish `$error` and MutationFeedback
 * announces it in a toast, whatever lands here is the whole explanation the user gets.
 *
 * It used to throw Fastify's `error` field, which is the generic HTTP reason phrase - so deleting a
 * job and then saving an open edit form announced "Internal Server Error" and nothing else. The
 * actual cause was sitting in `message` on the same payload.
 */

function mockResponse(status: number, payload: unknown, statusText = 'Internal Server Error') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: () => Promise.resolve(payload),
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetcher error messages are actionable', () => {
  // Fastify's shape: `error` is the reason phrase, `message` is the cause.
  it('reports the cause, not the HTTP reason phrase', async () => {
    mockResponse(500, {
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Daemon RPC error 500: Job not found: verify-toast',
    });

    await expect(fetcher('PUT /api/jobs/verify-toast', undefined, {})).rejects.toThrow(/Job not found/);
  });

  it('does not settle for the reason phrase when a cause exists', async () => {
    mockResponse(500, { error: 'Internal Server Error', message: 'Command failed: Invalid cron schedule' });

    await expect(fetcher('POST /api/jobs', undefined, {})).rejects.toThrow(/Invalid cron schedule/);
  });

  it('falls back to the reason phrase when there is no cause', async () => {
    mockResponse(502, { error: 'Bad Gateway' });

    await expect(fetcher('GET /api/jobs')).rejects.toThrow('Bad Gateway');
  });

  it('falls back to statusText when the body carries neither', async () => {
    mockResponse(503, {}, 'Service Unavailable');

    await expect(fetcher('GET /api/jobs')).rejects.toThrow('Service Unavailable');
  });

  it('carries the status code, so a caller can distinguish a 404 from a 500', async () => {
    mockResponse(404, { message: 'no such job' });

    await expect(fetcher('GET /api/jobs/nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('fetcher success paths', () => {
  it('returns the parsed body', async () => {
    mockResponse(200, { jobs: [] });
    await expect(fetcher('GET /api/jobs')).resolves.toEqual({ jobs: [] });
  });

  // 204 has no body, so parsing it would throw where nothing is wrong.
  it('returns undefined for 204 without parsing a body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      json: () => Promise.reject(new Error('should not be parsed')),
    }));

    await expect(fetcher('DELETE /api/jobs/x')).resolves.toBeUndefined();
  });

  it('splits "METHOD /path" into a method and a url', async () => {
    mockResponse(200, {});
    await fetcher('POST /api/jobs', undefined, { a: 1 });

    const [path, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(path).toBe('/api/jobs');
    expect((init as RequestInit).method).toBe('POST');
  });
});
