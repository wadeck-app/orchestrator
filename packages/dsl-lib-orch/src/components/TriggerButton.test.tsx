import React from 'react';
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TriggerButton } from './TriggerButton.js';

const FAST_MS = 50;

describe('TriggerButton', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows "Run now" in idle state', () => {
    render(<TriggerButton jobId="j1" onTrigger={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent('Run now');
  });

  it('shows "Running..." and is disabled while trigger is in flight', async () => {
    let resolve!: () => void;
    const onTrigger = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

    // delay:null makes events fire synchronously so we can inspect the loading state
    const user = userEvent.setup({ delay: null });
    void user.click(screen.getByRole('button'));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('button')).toHaveTextContent('Running...');
    expect(screen.getByRole('button')).toBeDisabled();
    resolve();
  });

  it('shows "Triggered" (success) then reverts to idle', async () => {
    const onTrigger = vi.fn().mockResolvedValue(undefined);
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveTextContent('Triggered');
    expect(screen.getByRole('button')).toHaveClass('bg-success');

    await waitFor(() =>
      expect(screen.getByRole('button')).toHaveTextContent('Run now'),
      { timeout: FAST_MS + 200 }
    );
  });

  it('shows error message (failure) then reverts to idle', async () => {
    const onTrigger = vi.fn().mockRejectedValue(new Error('daemon-not-running'));
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

    await userEvent.click(screen.getByRole('button'));

    expect(screen.getByRole('button')).toHaveTextContent('daemon-not-running');
    expect(screen.getByRole('button')).toHaveClass('bg-danger');

    await waitFor(() =>
      expect(screen.getByRole('button')).toHaveTextContent('Run now'),
      { timeout: FAST_MS + 200 }
    );
  });

  // A job at its concurrency limit refuses the run. That is an outcome, not a failure: it must not
  // read as "Triggered" (nothing started) nor as "Error" (nothing went wrong).
  describe('when the job is already running at its limit', () => {
    const REFUSED = { status: 'already-running', running: 1, maxConcurrency: 1 } as const;

    it('says so, with the count, instead of Triggered or Error', async () => {
      const onTrigger = vi.fn().mockResolvedValue(REFUSED);
      render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={500} />);

      await userEvent.click(screen.getByRole('button'));

      const btn = screen.getByRole('button');
      expect(btn).toHaveTextContent('Already running (1/1)');
      expect(btn).not.toHaveClass('bg-danger');
      expect(btn).not.toHaveClass('bg-success');
    });

    it('a second click forces the run', async () => {
      const onTrigger = vi.fn()
        .mockResolvedValueOnce(REFUSED)
        .mockResolvedValueOnce(undefined);
      render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={500} />);

      await userEvent.click(screen.getByRole('button'));
      await userEvent.click(screen.getByRole('button'));

      expect(onTrigger).toHaveBeenNthCalledWith(1, 'j1', undefined);
      expect(onTrigger).toHaveBeenNthCalledWith(2, 'j1', { force: true });
      expect(screen.getByRole('button')).toHaveTextContent('Triggered');
    });

    it('does not announce a successful trigger', async () => {
      const events: CustomEvent[] = [];
      const listener = (e: Event): void => { events.push(e as CustomEvent); };
      window.addEventListener('orch:job-triggered', listener);
      const onTrigger = vi.fn().mockResolvedValue(REFUSED);
      render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

      await userEvent.click(screen.getByRole('button'));
      window.removeEventListener('orch:job-triggered', listener);

      expect(events.map(e => e.detail)).toEqual([{ jobId: 'j1', success: false, refused: true }]);
    });

    it('reverts to idle, so the force offer does not linger', async () => {
      const onTrigger = vi.fn().mockResolvedValue(REFUSED);
      render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

      await userEvent.click(screen.getByRole('button'));

      await waitFor(() =>
        expect(screen.getByRole('button')).toHaveTextContent('Run now'),
        { timeout: FAST_MS + 200 }
      );
    });
  });

  it('is disabled during loading (double-click protection)', async () => {
    let resolve!: () => void;
    const onTrigger = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={FAST_MS} />);

    const user = userEvent.setup({ delay: null });
    void user.click(screen.getByRole('button'));
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('button')).toBeDisabled();
    expect(onTrigger).toHaveBeenCalledTimes(1);
    resolve();
  });
});

// Reported from a screenshot: "Run now" sat 8px shorter than the "View logs" / "Edit" /
// "Delete" buttons beside it. It was hand-rolled at px-3 py-1.5 text-xs while those come
// from dsl-ui at px-4 py-2 text-sm. Geometry belongs to the design system, so this button
// must not carry its own padding or font size.
describe('TriggerButton geometry comes from the design system', () => {
  it('renders the design system button, not a hand-rolled one', () => {
    render(<TriggerButton jobId="j1" onTrigger={async () => {}} />);

    const btn = screen.getByRole('button');
    // dsl-ui's button base; absent from the previous hand-rolled class string.
    expect(btn.className).toContain('justify-center');
    expect(btn.className).toContain('focus-visible:ring-2');
  });

  it('sets no padding or font size of its own', () => {
    render(<TriggerButton jobId="j1" onTrigger={async () => {}} />);

    const cls = screen.getByRole('button').className;
    // The exact combination that made it shorter than its neighbours.
    expect(cls).not.toContain('py-1.5');
    expect(cls).not.toContain('text-xs');
  });

  it('matches the size its neighbours use, so a row of actions lines up', () => {
    render(<TriggerButton jobId="j1" onTrigger={async () => {}} />);

    const cls = screen.getByRole('button').className;
    // dsl-ui `md`, which is what ButtonAction renders and what sits next to it.
    expect(cls).toContain('px-4');
    expect(cls).toContain('py-2');
    expect(cls).toContain('text-sm');
  });
});

// A card footer is a compact context; a detail page's action row is not. Aligning this
// button to `md` fixed the action row and then left it 12px taller than the "Logs" link
// beside it in every job card. Size is the host's call, not this component's.
describe('TriggerButton size', () => {
  it('defaults to md, matching a detail page action row', () => {
    render(<TriggerButton jobId="j1" onTrigger={async () => {}} />);

    expect(screen.getByRole('button').className).toContain('px-4');
  });

  it('accepts sm for compact hosts like a card footer', () => {
    render(<TriggerButton jobId="j1" onTrigger={async () => {}} size="sm" />);

    const cls = screen.getByRole('button').className;
    expect(cls).toContain('px-3');
    expect(cls).toContain('text-xs');
  });
});
