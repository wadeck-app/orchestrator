import type { Fetcher } from '@wadeck-app/dsl-renderer';

// dsl-renderer Fetcher: url format is "METHOD /path" (e.g. "GET /api/jobs")
export const fetcher: Fetcher = async (
  url: string,
  _params?: Record<string, string>,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<unknown> => {
  const spaceIdx = url.indexOf(' ');
  const method = spaceIdx >= 0 ? url.slice(0, spaceIdx) : 'GET';
  const path = spaceIdx >= 0 ? url.slice(spaceIdx + 1) : url;
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...extraHeaders,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined;
  const data = await res.json();
  if (!res.ok) {
    // `message` before `error`: in Fastify's error payload `error` is the generic HTTP reason phrase
    // ("Internal Server Error") and `message` is the cause ("Job not found: verify-toast"). This
    // string is now what the user reads - brains publish it as $error and it is announced in a toast
    // - so picking the reason phrase told them only that something, somewhere, went wrong.
    const { message, error } = data as { message?: string; error?: string };
    throw Object.assign(new Error(message ?? error ?? res.statusText), { status: res.status });
  }
  return data;
};
