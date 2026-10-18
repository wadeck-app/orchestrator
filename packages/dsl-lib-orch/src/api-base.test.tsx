import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, getApiBase, resetOrchUiConfig } from './runtime-config.js';
import { postTrigger, postTriggerEarly } from './trigger-job.js';
import { JobToggle } from './components/JobToggle.js';
import { JobCardGrid } from './components/JobCardGrid.js';
import { RunningAlertDetail } from './components/RunningAlertDetail.js';
import { RunningBannerDetail } from './components/RunningBannerDetail.js';
import { RunningInlineDetail } from './components/RunningInlineDetail.js';
import type { Job, RuntimeEntry } from './types.js';

/*
 * dsl-lib-orch is served from two places: orch-app, where the API lives at /api, and an app-core module,
 * where the module's routes live under /api/modules/orchestrator. The module bundle sets the base
 * once at load; these components used to hardcode /api and so called app-core's own server.
 */
const BASE = '/api/modules/orchestrator';

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget',
};
const IDLE: RuntimeEntry[] = [
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 0, pid: 1 },
];
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 7 }];

const ok = (): Response => new Response(null, { status: 204 });

beforeEach(() => { resetOrchUiConfig(); });
afterEach(() => {
  vi.restoreAllMocks();
  resetOrchUiConfig();
});

describe('runtime config', () => {
  it('defaults to no prefix, so orch-app keeps calling /api', () => {
    expect(getApiBase()).toBe('');
  });

  it('returns the configured base', () => {
    configureOrchUi({ apiBase: BASE });
    expect(getApiBase()).toBe(BASE);
  });

  it('rejects a base that ends with a slash, instead of producing //api/ URLs', () => {
    expect(() => configureOrchUi({ apiBase: `${BASE}/` })).toThrow(/trailing slash/i);
    expect(getApiBase()).toBe('');
  });

  it('rejects a base that is not an absolute path', () => {
    expect(() => configureOrchUi({ apiBase: 'api/modules/orchestrator' })).toThrow(/must start with "\/"/);
  });
});

describe('postTrigger / postTriggerEarly', () => {
  it('use the configured base when the caller gives none', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });

    await postTrigger('j1');
    await postTriggerEarly('j1');

    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/trigger`, { method: 'POST' });
    expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/trigger-early`, { method: 'POST' });
  });

  it('let an explicit base win over the configured one', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });

    await postTrigger('j1', undefined, 'http://other');

    expect(fetchMock).toHaveBeenCalledWith('http://other/api/jobs/j1/trigger', { method: 'POST' });
  });
});

describe('JobToggle', () => {
  it('toggles through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    render(<JobToggle job={JOB} />);

    await userEvent.setup().click(screen.getByRole('switch'));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/disable`, { method: 'POST' }); });
  });
});

describe('JobCardGrid self-owned actions', () => {
  async function selectJob() {
    const user = userEvent.setup();
    render(<MemoryRouter><JobCardGrid items={[{ job: JOB, runHistory: [] }]} /></MemoryRouter>);
    await user.click(screen.getByLabelText('Select Job A'));
    return user;
  }

  it('enables through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    const user = await selectJob();

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/enable`, { method: 'POST' }); });
  });

  it('disables through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    const user = await selectJob();

    await user.click(screen.getByRole('button', { name: 'Disable' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/disable`, { method: 'POST' }); });
  });

  it('deletes through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    const user = await selectJob();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1`, { method: 'DELETE' }); });
  });
});

describe.each([
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const)('%s', (_name, Detail) => {
  it('kills through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    const user = userEvent.setup();
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={RUNNING} /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /^kill/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Kill' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1/kill`, { method: 'POST' }); });
  });

  it('keeps calling /api when nothing is configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    const user = userEvent.setup();
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={RUNNING} /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: /^kill/i }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Kill' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/kill', { method: 'POST' }); });
  });
});

// Idle jobs show Run now, not Kill; the delete confirmation exists on every variant too.
describe.each([
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const)('%s delete', (_name, Detail) => {
  it('deletes through the configured base', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok());
    configureOrchUi({ apiBase: BASE });
    const user = userEvent.setup();
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={IDLE} /></MemoryRouter>);

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /yes, delete/i }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledWith(`${BASE}/api/jobs/j1`, { method: 'DELETE' }); });
  });
});
