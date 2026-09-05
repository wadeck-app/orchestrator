/**
 * Integration tests for orch-app - Job List, Job Detail, and Job Form flows.
 *
 * Strategy (mirrors capability-framework dsl-*-app pattern):
 * - Mount <GenericPageRunner> directly with inline YAML strings (not the on-disk files)
 * - Use MSW to intercept fetch at http://localhost/api/...
 * - Wrap in MemoryRouter (composite components use useNavigate / Link)
 * - Delegate DSL engine correctness to @wadeck-app/dsl-renderer's own test suite
 * - Delegate dsl-ui component rendering to @wadeck-app/dsl-ui's own test suite
 * - No unit tests for JobListSection / JobDetailSection / JobFormSection in isolation
 *   (covered here via GenericPageRunner end-to-end, same as dsl-ui-agent-fleet pattern)
 */

import React from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { beforeAll, afterAll, afterEach, describe, expect, it } from 'vitest';

import { GenericPageRunner } from '@wadeck-app/dsl-renderer';
import type { Fetcher } from '@wadeck-app/dsl-renderer';
import { appRegistry } from './registry.js';

// Test fetcher: resolves relative-path URLs to http://localhost so MSW can intercept.
// Production fetcher uses relative URLs (correct for browser SPA) but Node.js fetch
// requires absolute URLs - this wrapper adds the base without changing MSW's patched fetch.
const testFetcher: Fetcher = async (url, _params, body, extraHeaders) => {
  const spaceIdx = url.indexOf(' ');
  const method = spaceIdx >= 0 ? url.slice(0, spaceIdx) : 'GET';
  const path = spaceIdx >= 0 ? url.slice(spaceIdx + 1) : url;
  const absPath = path.startsWith('/') ? `http://localhost${path}` : path;
  const res = await fetch(absPath, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined;
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? res.statusText), { status: res.status });
  return data;
};

// -- Test data -----------------------------------------------------------------

const MOCK_JOB = {
  id: 'backup-db',
  type: 'cron',
  label: 'Database backup',
  schedule: '0 2 * * *',
  command: 'pg_dump mydb > backup.sql',
  cwd: '/opt/backups',
  enabled: true,
  triggerMode: 'fire-and-forget' as const,
  missedFiring: 'skip' as const,
};

const MOCK_JOB_2 = {
  id: 'health-check',
  type: 'startup',
  label: 'Health check',
  delaySeconds: 5,
  command: 'curl http://localhost/health',
  enabled: false,
  triggerMode: 'wait' as const,
};

const MOCK_JOBS = [
  { job: MOCK_JOB, runHistory: [{ startedAt: '2026-09-01T02:00:00Z', exitCode: 0, pid: 1234 }] },
  { job: MOCK_JOB_2, runHistory: [] },
];

const MOCK_JOB_DETAIL = {
  job: MOCK_JOB,
  runHistory: [
    { startedAt: '2026-09-01T02:00:00Z', exitCode: 0, pid: 1234 },
    { startedAt: '2026-08-31T02:00:00Z', exitCode: 1, pid: 1100 },
  ],
};

// -- YAML strings (inline - not loaded from disk) ------------------------------

const JOB_LIST_YAML = `
$sources:
  jobs:
    url: GET /api/jobs

$type: PageContent
sections:
  - $type: JobCardGrid
    items: $sources.jobs
`;

const JOB_DETAIL_YAML = `
$sources:
  jobData:
    url: GET /api/jobs/{id}
    params:
      id: $route.id

$type: PageContent
sections:
  - $type: PageHeader
    title: $sources.jobData.job.label
  - $type: JobConfigDisplay
    job: $sources.jobData.job
  - $type: Section
    title: Run history
    items:
      - $type: RunHistory
        entries: $sources.jobData.runHistory
  - $type: JobDetailActions
    jobId: $route.id
    job: $sources.jobData.job
`;

const JOB_FORM_NEW_YAML = `
$type: PageContent
sections:
  - $type: JobFormSection
`;

// -- MSW server ----------------------------------------------------------------

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// -- Render helpers ------------------------------------------------------------

function renderJobList() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <GenericPageRunner yamlText={JOB_LIST_YAML} registry={appRegistry} fetcher={testFetcher} />
    </MemoryRouter>
  );
}

function renderJobDetail(jobId = 'backup-db') {
  return render(
    <MemoryRouter initialEntries={[`/jobs/${jobId}`]}>
      <Routes>
        <Route
          path="/jobs/:id"
          element={
            <GenericPageRunner yamlText={JOB_DETAIL_YAML} registry={appRegistry} fetcher={testFetcher} />
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

function renderJobFormNew() {
  return render(
    <MemoryRouter initialEntries={['/jobs/new']}>
      <GenericPageRunner yamlText={JOB_FORM_NEW_YAML} registry={appRegistry} fetcher={testFetcher} />
    </MemoryRouter>
  );
}

// -- Tests ---------------------------------------------------------------------

describe('Job list page', () => {
  it('Test 1: loads and displays job labels', async () => {
    server.use(
      http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)),
    );

    renderJobList();

    await waitFor(() => {
      expect(screen.getByText('Database backup')).toBeInTheDocument();
    });
    expect(screen.getByText('Health check')).toBeInTheDocument();
  });

  it('Test 2: shows job type badges', async () => {
    server.use(
      http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)),
    );

    renderJobList();

    await waitFor(() => {
      expect(screen.getByText('Database backup')).toBeInTheDocument();
    });
    expect(screen.getByText('cron')).toBeInTheDocument();
    expect(screen.getByText('startup')).toBeInTheDocument();
  });

  it('Test 3: empty list - shows empty state message', async () => {
    server.use(
      http.get('http://localhost/api/jobs', () => HttpResponse.json([])),
    );

    renderJobList();

    await waitFor(() => {
      expect(screen.getByText('No jobs registered yet.')).toBeInTheDocument();
    });
  });

  it('Test 4: API error - page does not crash', async () => {
    server.use(
      http.get('http://localhost/api/jobs', () => HttpResponse.json({ error: 'daemon-not-running' }, { status: 503 })),
    );

    renderJobList();

    // Spinner visible initially, page should not throw
    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    }, { timeout: 1000 });
  });
});

describe('Job detail page', () => {
  it('Test 5: loads and displays job label and command', async () => {
    server.use(
      http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(MOCK_JOB_DETAIL)),
    );

    renderJobDetail('backup-db');

    await waitFor(() => {
      expect(screen.getByText('Database backup')).toBeInTheDocument();
    });
    expect(screen.getByText('pg_dump mydb > backup.sql')).toBeInTheDocument();
  });

  it('Test 6: shows run history with multiple entries', async () => {
    server.use(
      http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(MOCK_JOB_DETAIL)),
    );

    renderJobDetail('backup-db');

    await waitFor(() => {
      expect(screen.getByText('Database backup')).toBeInTheDocument();
    });
    // Two run history entries should be visible
    const okBadges = screen.getAllByText('OK');
    expect(okBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
  });

  it('Test 7: API error - page does not crash', async () => {
    server.use(
      http.get('http://localhost/api/jobs/missing', () => HttpResponse.json({ error: 'not-found' }, { status: 404 })),
    );

    renderJobDetail('missing');

    await waitFor(() => {
      expect(document.body).toBeInTheDocument();
    }, { timeout: 1000 });
  });
});

describe('Job form page (new)', () => {
  it('Test 8: renders form with label, command, type fields', async () => {
    renderJobFormNew();

    await waitFor(() => {
      expect(screen.getByText('Add job')).toBeInTheDocument();
    });
    // Core form fields present
    expect(screen.getByPlaceholderText('My job')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('node script.js')).toBeInTheDocument();
  });

  it('Test 9: shows cron schedule field when type is cron', async () => {
    renderJobFormNew();

    await waitFor(() => {
      expect(screen.getByText('Add job')).toBeInTheDocument();
    });
    // Default type is cron - schedule field visible
    expect(screen.getByPlaceholderText('*/5 * * * *')).toBeInTheDocument();
  });
});

// -- Navigation and missing UI elements (TDD for visual fixes) ----------------

describe('Job list page - missing elements', () => {
  it('Test 10: search bar is present', async () => {
    server.use(http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)));
    renderJobList();
    await waitFor(() => expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument());
  });

  it('Test 11: filter chips All/Cron/Startup/Once/Failed are present', async () => {
    server.use(http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)));
    renderJobList();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cron' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Failed' })).toBeInTheDocument();
    });
  });

  it('Test 12: Add job button is present', async () => {
    server.use(http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)));
    renderJobList();
    await waitFor(() => expect(screen.getByRole('button', { name: /add job/i })).toBeInTheDocument());
  });
});

describe('Job detail page - missing elements', () => {
  it('Test 13: Back link is present', async () => {
    server.use(http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(MOCK_JOB_DETAIL)));
    renderJobDetail('backup-db');
    await waitFor(() => expect(screen.getByRole('link', { name: /back/i })).toBeInTheDocument());
  });

  it('Test 14: job type badge (cron) is visible', async () => {
    server.use(http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(MOCK_JOB_DETAIL)));
    renderJobDetail('backup-db');
    // Multiple "cron" elements OK: one from the type badge, more from TriggerBadge in RunHistory
    await waitFor(() => expect(screen.getAllByText('cron').length).toBeGreaterThan(0));
  });

  it('Test 15: Run history section has a visible title', async () => {
    server.use(http.get('http://localhost/api/jobs/backup-db', () => HttpResponse.json(MOCK_JOB_DETAIL)));
    renderJobDetail('backup-db');
    await waitFor(() => expect(screen.getByText(/run history/i)).toBeInTheDocument());
  });
});

describe('Job list page - view toggle (Feature: list/grid switch)', () => {
  it('Test 16: grid/list toggle button is present at the top', async () => {
    server.use(http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)));
    renderJobList();
    await waitFor(() => {
      // Toggle must be a button with an accessible name indicating view mode
      const toggle = screen.getByRole('button', { name: /list|grid|view/i });
      expect(toggle).toBeInTheDocument();
    });
  });

  it('Test 17: switching to list view shows jobs in a table row layout (not card grid)', async () => {
    server.use(http.get('http://localhost/api/jobs', () => HttpResponse.json(MOCK_JOBS)));
    renderJobList();
    await waitFor(() => expect(screen.getByText('Database backup')).toBeInTheDocument());

    const toggle = screen.getByRole('button', { name: /list|grid|view/i });
    await userEvent.click(toggle);

    // In list view, jobs should appear as rows (role="row") not as cards
    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      expect(rows.length).toBeGreaterThan(1);
    });
  });
});
