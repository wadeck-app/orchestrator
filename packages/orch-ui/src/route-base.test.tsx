import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appPath, configureOrchUi, getRouteBase, resetOrchUiConfig } from './runtime-config.js';
import { DesignSwitcher } from './components/DesignSwitcher.js';
import { LogPageBreadcrumb } from './components/LogPageBreadcrumb.js';
import { RunHistory } from './components/RunHistory.js';
import { JobCard } from './components/JobCard.js';
import { JobCardGrid } from './components/JobCardGrid.js';
import { RunningAlertDetail } from './components/RunningAlertDetail.js';
import { RunningBannerDetail } from './components/RunningBannerDetail.js';
import { RunningInlineDetail } from './components/RunningInlineDetail.js';
import type { Job, RuntimeEntry } from './types.js';

/*
 * Inside an app-core module the pages are mounted under /modules/orchestrator, not at the root, so
 * every link and navigation orch-ui makes has to carry that prefix. orch-app mounts them at the
 * root and sets nothing.
 */
const BASE = '/modules/orchestrator';

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget',
};
const RUN: RuntimeEntry = { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1 };
const IDLE: RuntimeEntry[] = [RUN];

function LocationProbe(): React.ReactElement {
  return <div data-testid="location">{useLocation().pathname}</div>;
}

const hrefOf = (el: HTMLElement): string | null => el.closest('a')?.getAttribute('href') ?? null;

beforeEach(() => {
  resetOrchUiConfig();
  localStorage.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOrchUiConfig();
});

describe('route base config', () => {
  it('defaults to no prefix, so orch-app keeps its root-relative links', () => {
    expect(getRouteBase()).toBe('');
    expect(appPath('/jobs/j1')).toBe('/jobs/j1');
    expect(appPath('/')).toBe('/');
  });

  it('prefixes every app path once configured', () => {
    configureOrchUi({ routeBase: BASE });
    expect(getRouteBase()).toBe(BASE);
    expect(appPath('/jobs/j1/logs')).toBe(`${BASE}/jobs/j1/logs`);
    expect(appPath('/')).toBe(`${BASE}/`);
  });

  it('configures the api base and the route base independently', () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    configureOrchUi({ routeBase: BASE });
    expect(getRouteBase()).toBe(BASE);
  });

  it('rejects a malformed route base, without changing the current one', () => {
    configureOrchUi({ routeBase: BASE });
    expect(() => configureOrchUi({ routeBase: `${BASE}/` })).toThrow(/trailing slash/i);
    expect(() => configureOrchUi({ routeBase: 'modules/orchestrator' })).toThrow(/must start with "\/"/);
    expect(getRouteBase()).toBe(BASE);
  });
});

describe('links', () => {
  it('DesignSwitcher prefixes every design link', () => {
    configureOrchUi({ routeBase: BASE });
    render(<DesignSwitcher jobId="j1" current="design-a" />);
    expect(screen.getByRole('link', { name: 'Default' })).toHaveAttribute('href', `${BASE}/jobs/j1`);
    expect(screen.getByRole('link', { name: /Design A/ })).toHaveAttribute('href', `${BASE}/jobs/j1/design-a`);
  });

  it('LogPageBreadcrumb links back to the prefixed job page', () => {
    configureOrchUi({ routeBase: BASE });
    render(<MemoryRouter><LogPageBreadcrumb jobId="j1" jobLabel="Job A" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /back/i })).toHaveAttribute('href', `${BASE}/jobs/j1`);
  });

  it('RunHistory links each run to the prefixed log page', () => {
    configureOrchUi({ routeBase: BASE });
    render(<MemoryRouter><RunHistory entries={IDLE} jobId="j1" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /logs/i }).getAttribute('href')).toMatch(
      new RegExp(`^${BASE}/jobs/j1/logs\\?run=`),
    );
  });

  it('JobCard links to the prefixed log page', () => {
    configureOrchUi({ routeBase: BASE });
    render(
      <MemoryRouter>
        <JobCard job={JOB} runHistory={IDLE} onTrigger={vi.fn()} onToggle={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /logs/i })).toHaveAttribute('href', `${BASE}/jobs/j1/logs`);
  });

  it.each([
    ['RunningAlertDetail', RunningAlertDetail],
    ['RunningBannerDetail', RunningBannerDetail],
    ['RunningInlineDetail', RunningInlineDetail],
  ] as const)('%s links to the prefixed logs and edit pages', (_name, Detail) => {
    configureOrchUi({ routeBase: BASE });
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={IDLE} /></MemoryRouter>);
    expect(hrefOf(screen.getByText('View logs'))).toBe(`${BASE}/jobs/j1/logs`);
    expect(hrefOf(screen.getByText('Edit'))).toBe(`${BASE}/jobs/j1/edit`);
  });

  it('keeps root-relative links when nothing is configured', () => {
    render(<MemoryRouter><RunHistory entries={IDLE} jobId="j1" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /logs/i }).getAttribute('href')).toMatch(/^\/jobs\/j1\/logs\?run=/);
  });
});

describe('JobCardGrid navigation', () => {
  function renderGrid() {
    render(
      <MemoryRouter initialEntries={[`${BASE}/`]}>
        <LocationProbe />
        <JobCardGrid items={[{ job: JOB, runHistory: IDLE }]} />
      </MemoryRouter>,
    );
  }

  it('opens a job in the prefixed route', async () => {
    configureOrchUi({ routeBase: BASE });
    renderGrid();
    await userEvent.setup().click(screen.getByText('Job A'));
    expect(screen.getByTestId('location')).toHaveTextContent(`${BASE}/jobs/j1`);
  });

  it('adds a job in the prefixed route', async () => {
    configureOrchUi({ routeBase: BASE });
    renderGrid();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add job' }));
    expect(screen.getByTestId('location')).toHaveTextContent(`${BASE}/jobs/new`);
  });

  it('links the list view rows to the prefixed log page', async () => {
    configureOrchUi({ routeBase: BASE });
    localStorage.setItem('orch-view-mode', 'list');
    renderGrid();
    await waitFor(() => { expect(screen.getAllByRole('link', { name: /logs/i }).length).toBeGreaterThan(0); });
    for (const link of screen.getAllByRole('link', { name: /logs/i })) {
      expect(link).toHaveAttribute('href', `${BASE}/jobs/j1/logs`);
    }
  });
});

describe.each([
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const)('%s after a delete', (_name, Detail) => {
  it('goes back to the prefixed job list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const fakeLocation = { href: `${BASE}/jobs/j1` };
    vi.stubGlobal('location', fakeLocation);
    configureOrchUi({ routeBase: BASE });
    const user = userEvent.setup();
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={IDLE} /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(document.body).getByRole('button', { name: /yes, delete/i }));

    await waitFor(() => { expect(fakeLocation.href).toBe(`${BASE}/`); });
  });
});
