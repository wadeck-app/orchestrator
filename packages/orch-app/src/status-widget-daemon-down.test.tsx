/**
 * The dashboard widget (app-module-orchestrator status-widget.yaml) while the daemon is down: ONE red message
 * that names the problem and the command, not one per piece of the widget.
 */
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryRouter } from 'react-router-dom';
import { act, render, screen, waitFor } from '@testing-library/react';
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

// The real widget file; only the module namespace of the component is dropped (orch-app registers it bare).
const WIDGET_YAML = fs
  .readFileSync(path.resolve(__dirname, '../../app-module-orchestrator/src/dsl-views/status-widget.yaml'), 'utf8')
  .replace('orchestrator:DaemonStatus', 'DaemonStatus');

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
describe('status widget with the daemon down', () => {
  it('shows exactly one red message, which names the problem and the command', async () => {
    let healthServed = false;
    // What orch-core answers when the daemon is unreachable: /api/daemon refuses with 503 (DaemonStatus words it),
    // /api/health answers "no figures" (see jobs-routes.test.ts) so the renderer adds no banner of its own.
    server.use(
      http.get('http://localhost/api/modules/orchestrator/api/health', () => {
        healthServed = true;
        return HttpResponse.json({ status: 'daemon-down', totalJobs: null, runningJobs: null, recentFailures: null, uptime: null });
      }),
      http.get('http://localhost/api/daemon', () => HttpResponse.json({ error: 'daemon-not-running' }, { status: 503 })),
    );
    const { container } = render(
      <MemoryRouter initialEntries={['/']}>
        <GenericPageRunner yamlText={WIDGET_YAML} registry={appRegistry} fetcher={testFetcher} />
      </MemoryRouter>,
    );
    await screen.findByText(/orchestrator daemon is not running/);
    await waitFor(() => expect(healthServed).toBe(true));
    // One macrotask, not a sleep: lets the renderer's load-failure handling run if the health call had failed.
    await act(async () => { await new Promise<void>(resolve => { setTimeout(resolve, 0); }); });
    // Every red message of the widget is an alert (the renderer's load-failure banner, DaemonStatus).
    const red = Array.from(container.querySelectorAll('[role="alert"]'));
    expect(red.map(e => e.textContent)).toEqual([
      'The orchestrator daemon is not running, so its status cannot be read. Start it with "orch start", then reload this page.',
    ]);
  });
});
