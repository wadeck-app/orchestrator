import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { DaemonStatus, DAEMON_STATUS_REFRESH_MS, type DaemonInfo } from './DaemonStatus.js';

/*
 * The daemon is the part of the system nothing on screen described: which version, since when, whether a
 * restart will stop the jobs, and whether every timer is armed. These tests hold the card to those answers
 * and to a plain wording for every state in which it has none.
 */
const NOW = Date.parse('2026-10-19T12:00:00Z');
const STARTED = '2026-10-19T10:00:00.000Z';

function info(extra: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    version: '1.4.2',
    pid: 4242,
    port: 47900,
    startedAt: STARTED,
    uptimeSeconds: 7200,
    config: {
      supervisedJobs: true, lateActionWindowMinutes: 30, autoUpdate: true, appCore: true,
      catchUpInitialDelaySeconds: 300, catchUpStaggerSeconds: 300,
    },
    supervisor: { requested: true, active: true },
    runs: { running: 3, supervised: 2, followedAgain: 1 },
    scheduler: { armed: 5, desired: 5, problems: [] },
    ...extra,
  };
}

const reply = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetOrchUiConfig();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetOrchUiConfig();
});

describe('DaemonStatus - what it asks for', () => {
  it('asks the module through the configured api base', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator' });
    fetchMock.mockResolvedValue(reply(info()));

    render(<DaemonStatus />);
    await screen.findByText(/1\.4\.2/);

    expect(fetchMock).toHaveBeenCalledWith('/api/modules/orchestrator/api/daemon');
  });

  it('says it is reading while the daemon has not answered', () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    render(<DaemonStatus />);

    expect(screen.getByText(/Reading the daemon status/)).toBeInTheDocument();
  });
});

describe('DaemonStatus - the answer', () => {
  it('names the version and since when the daemon is up, with how long ago', async () => {
    fetchMock.mockResolvedValue(reply(info()));

    render(<DaemonStatus />);

    expect(await screen.findByText(/1\.4\.2/)).toBeInTheDocument();
    expect(screen.getByText(/Up since .*\(2h ago\)/)).toBeInTheDocument();
  });

  it('says jobs run under a supervisor, and what the late-action window means', async () => {
    fetchMock.mockResolvedValue(reply(info()));

    render(<DaemonStatus />);

    expect(await screen.findByText(/Jobs run under a supervisor/)).toBeInTheDocument();
    expect(screen.getByText(/ended less than 30 min before it came back/)).toBeInTheDocument();
  });

  it('says a late run never retries when the window is 0', async () => {
    fetchMock.mockResolvedValue(reply(info({ config: { ...info().config, lateActionWindowMinutes: 0 } })));

    render(<DaemonStatus />);

    expect(await screen.findByText(/never retries/)).toBeInTheDocument();
  });

  it('warns, with the daemon note, when the supervisor was asked for and is not there', async () => {
    const note = 'supervisedJobs is on (the default), but there is no supervisor executable for linux-x64. Jobs run unsupervised.';
    fetchMock.mockResolvedValue(reply(info({ supervisor: { requested: true, active: false, note } })));

    render(<DaemonStatus />);

    expect(await screen.findByText(/Jobs run without a supervisor/)).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('shows a neutral "off" when supervision was turned off, with no warning', async () => {
    fetchMock.mockResolvedValue(reply(info({ supervisor: { requested: false, active: false } })));

    render(<DaemonStatus />);

    expect(await screen.findByText(/Supervisor: off/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/ended less than/)).toBeNull();
  });

  it('counts the runs now, the supervised ones, and those followed again after the last start', async () => {
    fetchMock.mockResolvedValue(reply(info()));

    render(<DaemonStatus />);

    expect(await screen.findByText(/3 running/)).toBeInTheDocument();
    expect(screen.getByText(/2 supervised/)).toBeInTheDocument();
    expect(screen.getByText(/1 followed again after the last start/)).toBeInTheDocument();
  });

  it('says all timers are armed when they are', async () => {
    fetchMock.mockResolvedValue(reply(info()));

    render(<DaemonStatus />);

    expect(await screen.findByText(/All 5 timers armed/)).toBeInTheDocument();
  });

  it('lists the jobs whose timer has a problem, each linking to the job', async () => {
    fetchMock.mockResolvedValue(reply(info({
      scheduler: { armed: 4, desired: 5, problems: [{ jobId: 'backup', problem: 'enabled but NOTHING is armed for it' }] },
    })));

    render(<MemoryRouter><DaemonStatus /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: 'backup' });
    expect(link).toHaveAttribute('href', '/jobs/backup');
    expect(screen.getByText(/enabled but NOTHING is armed for it/)).toBeInTheDocument();
    expect(screen.getByText(/4 of 5 timers armed/)).toBeInTheDocument();
    expect(screen.queryByText(/All \d+ timers armed/)).toBeNull();
  });

  it('prefixes the job link with the route base and works outside a router', async () => {
    configureOrchUi({ apiBase: '/api/modules/orchestrator', routeBase: '/modules/orchestrator' });
    fetchMock.mockResolvedValue(reply(info({
      scheduler: { armed: 0, desired: 1, problems: [{ jobId: 'backup', problem: 'p' }] },
    })));

    render(<DaemonStatus />);

    expect(await screen.findByRole('link', { name: 'backup' })).toHaveAttribute('href', '/modules/orchestrator/jobs/backup');
  });
});

describe('DaemonStatus - when there is no answer', () => {
  it('tells how to start the daemon when it is not running (503)', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'daemon-not-running' }, 503));

    render(<DaemonStatus />);

    expect(await screen.findByText(/orchestrator daemon is not running/)).toBeInTheDocument();
    expect(screen.getByText(/orch start/)).toBeInTheDocument();
  });

  it('names the HTTP status and where to look for another refusal', async () => {
    fetchMock.mockResolvedValue(reply({ error: 'boom' }, 500));

    render(<DaemonStatus />);

    expect(await screen.findByText(/HTTP 500 \(boom\)/)).toBeInTheDocument();
    expect(screen.getByText(/orch logs/)).toBeInTheDocument();
  });

  it('says the dashboard server could not be reached when the request fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));

    render(<DaemonStatus />);

    expect(await screen.findByText(/Could not reach the dashboard server \(network down\)/)).toBeInTheDocument();
  });
});

describe('DaemonStatus - refresh', () => {
  it('reads again every 30 s, keeping the last answer when a refresh fails', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    fetchMock.mockResolvedValueOnce(reply(info()));
    fetchMock.mockRejectedValueOnce(new Error('gone'));

    render(<DaemonStatus />);
    await screen.findByText(/1\.4\.2/);
    expect(DAEMON_STATUS_REFRESH_MS).toBe(30_000);

    await act(async () => { await vi.advanceTimersByTimeAsync(DAEMON_STATUS_REFRESH_MS); });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/1\.4\.2/)).toBeInTheDocument();
    expect(screen.getByText(/could not be refreshed/i)).toBeInTheDocument();
  });
});
