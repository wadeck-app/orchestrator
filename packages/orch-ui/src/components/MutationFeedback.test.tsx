import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToastProvider } from '@wadeck-app/dsl-ui';
import { MutationFeedback } from './MutationFeedback.js';

/*
 * The complaint this exists for: clicking Save produced no visible consequence at all. The brain
 * owns the request, so a rejection reached only the console and a success looked identical to a
 * click that did nothing.
 *
 * The success path has to survive a FULL page load: the navigate brain assigns
 * window.location.href, so a toast raised before the redirect is destroyed by it. That is why the
 * message goes through sessionStorage rather than straight to the toast.
 */

const FLASH_KEY = 'orch.flash';

function mount(props: React.ComponentProps<typeof MutationFeedback>) {
  return render(
    <ToastProvider>
      <MutationFeedback {...props} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
});

describe('MutationFeedback failure path', () => {
  it('announces the failure, since nothing else would', async () => {
    mount({ pending: false, error: 'Daemon RPC error 500: nope' });

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    // The cause, not "something went wrong": the reader must not have to open the console.
    expect(screen.getByRole('status').textContent).toContain('nope');
  });

  it('does not announce the same failure twice on a re-render', async () => {
    const { rerender } = mount({ pending: false, error: 'boom' });
    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(1));

    rerender(
      <ToastProvider>
        <MutationFeedback pending={false} error="boom" />
      </ToastProvider>,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  // No navigation happens on failure, so nothing should be queued for a page that never loads.
  it('queues no success flash when the mutation failed', async () => {
    const { rerender } = mount({ pending: true, error: null, successMessage: 'Job saved' });
    rerender(
      <ToastProvider>
        <MutationFeedback pending={false} error="boom" successMessage="Job saved" />
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    expect(sessionStorage.getItem(FLASH_KEY)).toBeNull();
  });
});

describe('MutationFeedback success path', () => {
  it('queues the message for after the redirect, on the completion edge', () => {
    const { rerender } = mount({ pending: true, error: null, successMessage: 'Job created' });
    expect(sessionStorage.getItem(FLASH_KEY)).toBeNull();

    rerender(
      <ToastProvider>
        <MutationFeedback pending={false} error={null} successMessage="Job created" />
      </ToastProvider>,
    );

    expect(JSON.parse(sessionStorage.getItem(FLASH_KEY)!).message).toBe('Job created');
  });

  // Firing on `!pending` alone would announce a save on first mount, before anything was submitted.
  it('announces nothing when it was never pending', () => {
    mount({ pending: false, error: null, successMessage: 'Job created' });
    expect(sessionStorage.getItem(FLASH_KEY)).toBeNull();
  });

  it('shows a queued message on mount and consumes it', async () => {
    sessionStorage.setItem(FLASH_KEY, JSON.stringify({ message: 'Job created', at: Date.now() }));

    mount({});

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('Job created');
    });
    // Consumed, or every subsequent page would repeat it.
    expect(sessionStorage.getItem(FLASH_KEY)).toBeNull();
  });

  /*
   * A save that did not navigate would otherwise leave the message to surface on some unrelated
   * page later, describing something the user has forgotten doing.
   */
  it('drops a stale message rather than announcing it out of context', async () => {
    sessionStorage.setItem(
      FLASH_KEY,
      JSON.stringify({ message: 'Job created', at: Date.now() - 60_000 }),
    );

    mount({});

    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionStorage.getItem(FLASH_KEY)).toBeNull();
  });

  it('survives a corrupt or foreign value in storage', async () => {
    sessionStorage.setItem(FLASH_KEY, 'not json');

    mount({});

    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('MutationFeedback renders nothing itself', () => {
  it('adds no markup, so it can sit anywhere in a page', () => {
    const { container } = render(
      <ToastProvider>
        <MutationFeedback pending={false} />
      </ToastProvider>,
    );
    // Only the provider's own toast viewport, never a wrapper of its own.
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  // Rather than silently doing nothing, which is the failure mode it exists to remove.
  it('fails loudly when no ToastProvider is above it', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<MutationFeedback pending={false} />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});
