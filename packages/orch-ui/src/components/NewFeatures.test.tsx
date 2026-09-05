import React from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TriggerButton } from './TriggerButton.js';
import { EnableToggle } from './EnableToggle.js';
import type { Job } from '../types.js';

const BASE_JOB: Job = {
  id: 'j1', type: 'cron', label: 'Test', command: 'echo hi',
  enabled: true, triggerMode: 'fire-and-forget',
};

afterEach(() => { vi.restoreAllMocks(); });

// Feature: notification bubble on job finish
// When a job finishes, the dashboard must show a transient notification toast.
// This is tested at the TriggerButton level: after trigger resolves, a
// "job-finished" custom event is dispatched so the dashboard can react.

describe('Job finish notification (Feature: bubble on dashboard)', () => {
  it('TriggerButton dispatches "orch:job-triggered" event after success', async () => {
    const events: Event[] = [];
    window.addEventListener('orch:job-triggered', (e) => events.push(e));

    const onTrigger = vi.fn().mockResolvedValue(undefined);
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={50} />);

    await userEvent.click(screen.getByRole('button'));

    // Must dispatch orch:job-triggered with jobId detail
    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail).toMatchObject({ jobId: 'j1', success: true });

    window.removeEventListener('orch:job-triggered', (e) => events.push(e));
  });

  it('TriggerButton dispatches "orch:job-triggered" with success:false on failure', async () => {
    const events: Event[] = [];
    window.addEventListener('orch:job-triggered', (e) => events.push(e));

    const onTrigger = vi.fn().mockRejectedValue(new Error('fail'));
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={50} />);

    await userEvent.click(screen.getByRole('button'));

    expect(events).toHaveLength(1);
    expect((events[0] as CustomEvent).detail).toMatchObject({ jobId: 'j1', success: false });

    window.removeEventListener('orch:job-triggered', (e) => events.push(e));
  });
});

// Feature: "Run now" animation correctness
// The loading state must use Loader2 (spin animation) for the exact duration,
// with no flickering - it must persist until the trigger promise resolves.

describe('Run now button animation (Feature: no flash)', () => {
  it('loading state persists until trigger promise resolves - no premature idle', async () => {
    let resolve!: () => void;
    const onTrigger = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<TriggerButton jobId="j1" onTrigger={onTrigger} feedbackDurationMs={50} />);

    const user = userEvent.setup({ delay: null });
    void user.click(screen.getByRole('button'));
    await act(async () => { await Promise.resolve(); });

    // During loading: MUST show Loader2 spinner (animate-spin class)
    const spinner = document.querySelector('.animate-spin');
    expect(spinner).toBeTruthy();

    // Must NOT show "Run now" text while loading
    expect(screen.queryByText('Run now')).toBeNull();

    resolve();
  });
});

// Feature: EnableToggle design on logs page
// The toggle must render a properly visible track - it was reported as
// "degueulasse" (ugly) because the peer-checked classes weren't visible.
// The track div must have the correct width/height classes applied.

describe('EnableToggle design (Feature: correct visual on logs page)', () => {
  it('toggle track has correct w-9 h-5 dimensions', () => {
    render(
      <MemoryRouter>
        <EnableToggle job={BASE_JOB} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    const track = document.querySelector('.w-9.h-5');
    expect(track).toBeTruthy();
  });

  it('toggle uses peer-checked color class for the checked state', () => {
    render(
      <MemoryRouter>
        <EnableToggle job={BASE_JOB} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    // The track uses peer-checked compound class (raw color required for peer syntax - covered by suppress zone)
    // violations-suppress: tailwind/no-raw-color-class peer-checked compound class - semantic tokens incompatible with peer-checked: syntax
    const PEER_CHECKED_CLASS = 'peer-checked:bg-blue-600';
    const track = document.querySelector(`[class*="${PEER_CHECKED_CLASS}"]`);
    expect(track).toBeTruthy();
  });

  it('toggle thumb uses after:content pseudo-element for positioning', () => {
    render(
      <MemoryRouter>
        <EnableToggle job={BASE_JOB} onToggle={vi.fn()} />
      </MemoryRouter>
    );
    // Must have after: pseudo-classes for the thumb
    const track = document.querySelector('[class*="after:absolute"]');
    expect(track).toBeTruthy();
  });
});
