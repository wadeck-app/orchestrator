import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, RuntimeEntry } from '../types.js';

const JOB: Job = { id: 'j1', type: 'startup', label: 'Job A', command: 'node server.js', enabled: true, triggerMode: 'fire-and-forget' };
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 77 }];

const VARIANTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A refused stop must show the cause. Fastify puts the cause under `message` (and a generic reason
// phrase under `error`); the routes put it under `error`.
describe.each(VARIANTS)('%s stop failure', (_name, Detail) => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function stopJob(): Promise<void> {
    render(<MemoryRouter><Detail job={JOB} jobId="j1" runHistory={RUNNING} /></MemoryRouter>);
    await userEvent.click(screen.getAllByRole('button', { name: /^kill/i })[0]!);
    const buttons = screen.getAllByRole('button', { name: /^kill/i });
    await userEvent.click(buttons[buttons.length - 1]!);
  }

  it('shows the Fastify cause from `message`', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ statusCode: 500, error: 'Internal Server Error', message: 'stop failed: access denied' }, 500));

    await stopJob();

    await waitFor(() => { expect(screen.getByText('stop failed: access denied')).toBeInTheDocument(); });
  });

  it('shows the route cause from `error`', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'daemon-not-running' }, 503));

    await stopJob();

    await waitFor(() => { expect(screen.getByText('daemon-not-running')).toBeInTheDocument(); });
  });

  it('keeps its own wording when the body carries neither', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({}, 500));

    await stopJob();

    await waitFor(() => { expect(screen.getByText(/Failed to kill job \(HTTP 500\)/)).toBeInTheDocument(); });
  });
});
