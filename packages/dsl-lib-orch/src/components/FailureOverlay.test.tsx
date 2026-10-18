import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOrchUiConfig } from '../runtime-config.js';
import { FailureOverlay } from './FailureOverlay.js';

/*
 * The bottom-right stack of failure notifications, with the polling and the acknowledging built in, so
 * an app-core module can mount it once and have it on every page.
 */
const FAILURES = [
  { jobId: 'a', jobLabel: 'Job A', entry: { startedAt: '2026-10-18T09:10:00Z', exitCode: 1, pid: 1 } },
  { jobId: 'b', jobLabel: 'Job B', entry: { startedAt: '2026-10-18T09:20:00Z', exitCode: 2, pid: 2 } },
];

describe('FailureOverlay', () => {
  let posted: string[];

  beforeEach(() => {
    posted = [];
    resetOrchUiConfig();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).endsWith('/api/failures/ack')) {
        posted.push(String(init?.body));
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(FAILURES), { status: 200 });
    });
  });
  afterEach(() => { vi.restoreAllMocks(); resetOrchUiConfig(); });

  it('shows one card per failure', async () => {
    render(<FailureOverlay />);
    expect(await screen.findByText('Job A')).toBeInTheDocument();
    expect(screen.getByText('Job B')).toBeInTheDocument();
    expect(screen.getByText('exit 2')).toBeInTheDocument();
  });

  it('acknowledges the card it is pressed on, and only that one', async () => {
    render(<FailureOverlay />);
    await screen.findByText('Job A');

    await userEvent.setup().click(screen.getAllByRole('button', { name: 'Acknowledge' })[0]!);

    await waitFor(() => { expect(screen.queryByText('Job A')).toBeNull(); });
    expect(screen.getByText('Job B')).toBeInTheDocument();
    expect(posted).toEqual([JSON.stringify({ jobId: 'a' })]);
  });

  it('renders nothing at all when there is no failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('[]', { status: 200 }));
    const { container } = render(<FailureOverlay />);
    await waitFor(() => { expect(globalThis.fetch).toHaveBeenCalled(); });
    expect(container).toBeEmptyDOMElement();
  });
});
