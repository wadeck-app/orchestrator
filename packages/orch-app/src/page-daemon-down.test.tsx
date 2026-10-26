/**
 * Evidence, not a requirement: what the real orch-app job list and job detail pages show with the daemon unreachable.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, render, waitFor } from '@testing-library/react';
import { ToastProvider } from '@wadeck-app/dsl-ui';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GenericPageRunner } from '@wadeck-app/dsl-renderer';
import type { Fetcher } from '@wadeck-app/dsl-renderer';
import { appRegistry } from './registry.js';

const testFetcher: Fetcher = async (url, _params, body, extraHeaders) => {
  const spaceIdx = url.indexOf(' ');
  const method = spaceIdx >= 0 ? url.slice(0, spaceIdx) : 'GET';
  const p = spaceIdx >= 0 ? url.slice(spaceIdx + 1) : url;
  const res = await fetch(p.startsWith('/') ? `http://localhost${p}` : p, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) {
    return undefined;
  }
  const data = await res.json();
  if (!res.ok) {
    throw Object.assign(new Error((data as { error?: string }).error ?? res.statusText), { status: res.status });
  }
  return data;
};

const page = (name: string): string => fs.readFileSync(path.resolve(__dirname, "dsl/pages", name), "utf8");
const server = setupServer();
// Components call fetch with a relative URL (right in a browser); Node needs an absolute one for msw to see it.
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'warn' });
  // Taken after listen(): msw has patched fetch by then.
  const nodeFetch = globalThis.fetch;
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    nodeFetch(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init));
});
afterEach(() => server.resetHandlers());
afterAll(() => {
  vi.unstubAllGlobals();
  server.close();
});

/*
 * orch-app pages with the daemon unreachable. The handlers answer what orch-core answers then: 503
 * {error:'daemon-not-running'} on every route. What each page shows TODAY is asserted, not what it should show.
 */
async function alertsOf(container: HTMLElement, seen: () => boolean): Promise<string[]> {
  await waitFor(() => expect(seen()).toBe(true));
  // One macrotask, not a sleep: lets the renderer's load-failure handling and the components' own errors land.
  await act(async () => { await new Promise<void>(resolve => { setTimeout(resolve, 0); }); });
  return Array.from(container.querySelectorAll('[role="alert"]')).map(e => e.textContent ?? '');
}

describe('orch-app pages with the daemon down', () => {
  it('job list: two alerts (known issue)', async () => {
    let served = 0;
    server.use(http.get('http://localhost/api/*', () => {
      served++;
      return HttpResponse.json({ error: 'daemon-not-running' }, { status: 503 });
    }));
    const { container } = render(
      <ToastProvider><MemoryRouter initialEntries={['/']}>
        <GenericPageRunner yamlText={page('job-list.yaml')} registry={appRegistry} fetcher={testFetcher} />
      </MemoryRouter></ToastProvider>,
    );
    // /api/jobs (source) and /api/daemon (DaemonStatus).
    const alerts = await alertsOf(container, () => served >= 2);
    // KNOWN ISSUE, TWO red messages today: the renderer's generic banner for the failed primary source (no action in
    // it) plus DaemonStatus's own, which has the command. Root cause: the renderer's notifyLoadFailure has no per-source silence option, and orch-app
    // cannot pass hostNotify without rewriting the banner. When that changes, this test should expect one alert.
    expect(alerts).toEqual([
      'Could not load the data: daemon-not-running (HTTP 503)×',
      'The orchestrator daemon is not running, so its status cannot be read. Start it with "orch start", then reload this page.',
    ]);
  });

  it('job detail: two alerts (known issue)', async () => {
    let served = 0;
    server.use(http.get('http://localhost/api/*', () => {
      served++;
      return HttpResponse.json({ error: 'daemon-not-running' }, { status: 503 });
    }));
    const { container } = render(
      <ToastProvider><MemoryRouter initialEntries={['/jobs/backup-db']}>
        <Routes>
          <Route path="/jobs/:id" element={<GenericPageRunner yamlText={page('job-detail.yaml')} registry={appRegistry} fetcher={testFetcher} />} />
        </Routes>
      </MemoryRouter></ToastProvider>,
    );
    // /api/jobs/backup-db (source) and its resource-history.
    const alerts = await alertsOf(container, () => served >= 2);
    // KNOWN ISSUE, TWO red messages today: the renderer's generic banner for the failed primary source (no action in
    // it) plus ResourceHistory's own, which has the command. Root cause: the renderer's notifyLoadFailure has no per-source silence option, and orch-app
    // cannot pass hostNotify without rewriting the banner. When that changes, this test should expect one alert.
    expect(alerts).toEqual([
      'Could not load the data: daemon-not-running (HTTP 503)×',
      'The orchestrator daemon is not running, so the resource history cannot be read. Start it with "orch start", then reload this page.',
    ]);
  });
});
