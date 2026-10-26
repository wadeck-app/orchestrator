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
import { shouldNotifyLoadFailureFor } from './daemon-down-notice.js';

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

/*
 * With the daemon down every API route answers 503 {error:'daemon-not-running'} (what orch-core does). Each page must say it ONCE
 * and say what to do: the pages that carry a component with the command (DaemonStatus, ResourceHistory) keep that message alone;
 * the pages that carry none keep the renderer's generic banner, so that none of them is ever silent.
 */
function renderPage(file: string, route: string, entry: string, routePath?: string): { container: HTMLElement; served: () => number } {
  let served = 0;
  server.use(http.get('http://localhost/api/*', () => {
    served++;
    return HttpResponse.json({ error: 'daemon-not-running' }, { status: 503 });
  }));
  const yamlText = page(file);
  const runner = <GenericPageRunner yamlText={yamlText} registry={appRegistry} fetcher={testFetcher} shouldNotifyLoadFailure={shouldNotifyLoadFailureFor(yamlText)} />;
  const { container } = render(
    <ToastProvider><MemoryRouter initialEntries={[entry]}>
      {routePath === undefined ? runner : <Routes><Route path={routePath} element={runner} /></Routes>}
    </MemoryRouter></ToastProvider>,
  );
  void route;
  return { container, served: () => served };
}

const GENERIC = 'Could not load the data: daemon-not-running (HTTP 503)×';

describe('orch-app pages with the daemon down', () => {
  it('job list: one alert, the one with the command', async () => {
    const { container, served } = renderPage('job-list.yaml', 'job-list', '/');
    // /api/jobs (source) and /api/daemon (DaemonStatus).
    const alerts = await alertsOf(container, () => served() >= 2);
    expect(alerts).toEqual([
      'The orchestrator daemon is not running, so its status cannot be read. Start it with "orch start", then reload this page.',
    ]);
  });

  // The generic banner stays here although ResourceHistory also says the daemon is down: its message covers the charts only, and
  // without the banner the run history table would read "No runs yet" for a job that has runs (seen on the real page).
  it('job detail: the generic banner stays next to the resource history message', async () => {
    const { container, served } = renderPage('job-detail.yaml', 'job-detail', '/jobs/backup-db', '/jobs/:id');
    // /api/jobs/backup-db (source) and its resource-history.
    const alerts = await alertsOf(container, () => served() >= 2);
    expect(alerts).toEqual([
      GENERIC,
      'The orchestrator daemon is not running, so the resource history cannot be read. Start it with "orch start", then reload this page.',
    ]);
  });

  // These pages carry no component that says the daemon is down: the generic banner is all they have, and they must keep it.
  it.each([
    ['schedule.yaml', '/schedule'],
    ['audit.yaml', '/audit'],
  ])('%s: the generic banner stays, the page is not silent', async (file, entry) => {
    const { container, served } = renderPage(file, file, entry);
    const alerts = await alertsOf(container, () => served() >= 1);
    expect(alerts).toContain(GENERIC);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
  });
});
