/**
 * App routing: routes come from the page YAML ($route) through the generated dslRoutes, and a
 * route-param change remounts the page (GenericPageRunner does it itself; KeyedPageRunner is gone).
 *
 * The real <App> is mounted (it owns its BrowserRouter), so navigation goes through window.history.
 */

import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The production fetcher uses relative URLs, which Node's fetch rejects. Same wrapper as integration.test.tsx.
vi.mock('./fetcher.js', () => ({
  fetcher: async (url: string): Promise<unknown> => {
    const spaceIdx = url.indexOf(' ');
    const path = spaceIdx >= 0 ? url.slice(spaceIdx + 1) : url;
    const res = await fetch(`http://localhost${path}`);
    return res.json();
  },
}));

import App from './App.js';
import { dslRoutes } from './generated/routes.js';

const jobDetail = (id: string, label: string) => ({
  job: { id, type: 'cron', label, schedule: '0 2 * * *', command: 'echo hi', enabled: true, triggerMode: 'fire-and-forget', missedFiring: 'skip' },
  runHistory: [],
});

const server = setupServer(
  http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(jobDetail('backup-db', 'Database backup'))),
  http.get('http://localhost/api/jobs/health-check', () => HttpResponse.json(jobDetail('health-check', 'Health check'))),
  http.get('http://localhost/api/jobs', () => HttpResponse.json([])),
);

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function navigate(path: string): void {
  act(() => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

describe('App routes', () => {
  it('exposes every page that declares $route, with no duplicate', () => {
    const routes = dslRoutes.map(r => r.route);
    expect(routes.length).toBeGreaterThan(0);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toEqual(expect.arrayContaining(['/', '/jobs/new', '/jobs/:id', '/jobs/:id/logs', '/audit', '/schedule']));
  });

  it('renders a job page, then re-fetches and re-renders when only the :id param changes', async () => {
    window.history.pushState({}, '', '/jobs/backup-db');
    render(<App />);
    expect((await screen.findAllByText('Database backup')).length).toBeGreaterThan(0);

    navigate('/jobs/health-check');
    expect((await screen.findAllByText('Health check')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Database backup')).toBeNull();
  });

  it('redirects an unknown path to the job list', async () => {
    window.history.pushState({}, '', '/does-not-exist');
    render(<App />);
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
  });
});
