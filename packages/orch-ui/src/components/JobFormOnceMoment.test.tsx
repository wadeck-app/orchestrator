import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobForm } from './JobForm.js';
import type { Job } from '../types.js';

/*
 * The form asked "run after how many seconds", which is not how anyone decides when a one-off job
 * should run -- they decide "tomorrow at 09:00" and then do arithmetic the form should have done. It
 * also made "overdue" illegible: a stored delay of 10800 says nothing about whether the moment has
 * passed.
 *
 * It takes an absolute moment now, via dsl-ui's FieldDateTime, and converts on submit.
 *
 * The conversion is the part that needs pinning, and specifically on EDIT. A once job fires at
 * `scheduledAt + delayMs`. Sending a recomputed delayMs while the stored scheduledAt keeps its
 * original creation time means the daemon fires at `originalScheduledAt + newDelayMs` -- not the
 * moment the user picked. So scheduledAt must be re-stamped in the same patch.
 */

const NOW = Date.parse('2026-09-19T12:00:00.000Z');
const HOUR = 3_600_000;

beforeEach(() => {
  // shouldAdvanceTime, or testing-library's waitFor never resolves: it polls on a timer, and a frozen
  // clock means the poll never fires. The fixed system time is what these tests need; a frozen one is
  // not.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const EXISTING_ONCE: Job = {
  id: 'deploy',
  type: 'once',
  label: 'Deploy',
  command: 'echo go',
  enabled: true,
  triggerMode: 'fire-and-forget',
  // Created two days ago with a one-hour delay: it has long since fired or been waiting.
  scheduledAt: new Date(NOW - 48 * HOUR).toISOString(),
  delayMs: HOUR,
};

function renderForm(initial: Partial<Job>, onSubmit = vi.fn().mockResolvedValue(undefined)) {
  render(
    <MemoryRouter>
      <JobForm onSubmit={onSubmit} onCancel={() => {}} initial={initial} />
    </MemoryRouter>,
  );
  return onSubmit;
}

function save(): void {
  screen.getByRole('button', { name: 'Save' }).click();
}

/** The date half of FieldDateTime, which is the only textbox on the once form. */
function dateInput(): HTMLElement {
  return screen.getByLabelText(/^Run at/);
}

describe('the once form takes a moment, not a duration', () => {
  it('asks for a moment rather than a number of seconds', () => {
    renderForm({ ...EXISTING_ONCE });
    expect(screen.queryByLabelText(/Run after \(seconds\)/)).toBeNull();
    expect(dateInput()).toBeInTheDocument();
  });

  it('seeds the field from the job, so editing does not silently move the firing', () => {
    renderForm({ ...EXISTING_ONCE });
    // scheduledAt + delayMs = 47h before now.
    expect(dateInput()).toHaveValue('Sep 17, 2026');
  });
});

describe('what is sent on submit', () => {
  it('re-stamps scheduledAt so the daemon computes the moment the user picked', async () => {
    const onSubmit = renderForm({ ...EXISTING_ONCE });

    fireEvent.change(dateInput(), { target: { value: 'Sep 25, 2026' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const data = onSubmit.mock.calls[0]![0] as Partial<Job>;

    expect(data.scheduledAt).toBeDefined();
    const base = Date.parse(data.scheduledAt!);
    const fires = base + (data.delayMs ?? 0);
    // The moment the user picked: Sep 25, with the time carried over from the existing job.
    expect(new Date(fires).getUTCDate()).toBe(25);
    expect(new Date(fires).getUTCMonth()).toBe(8);
  });

  // The whole point of re-stamping: the old scheduledAt must not survive into the patch.
  it('does not leave the original scheduledAt in place', async () => {
    const onSubmit = renderForm({ ...EXISTING_ONCE });

    fireEvent.change(dateInput(), { target: { value: 'Sep 25, 2026' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const data = onSubmit.mock.calls[0]![0] as Partial<Job>;
    expect(data.scheduledAt).not.toBe(EXISTING_ONCE.scheduledAt);
  });

  it('delayMs stays a positive integer, which the daemon requires', async () => {
    const onSubmit = renderForm({ ...EXISTING_ONCE });

    fireEvent.change(dateInput(), { target: { value: 'Sep 25, 2026' } });
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const data = onSubmit.mock.calls[0]![0] as Partial<Job>;
    expect(Number.isInteger(data.delayMs)).toBe(true);
    expect(data.delayMs).toBeGreaterThan(0);
  });

  /*
   * A moment in the past cannot become a positive delayMs, and the daemon rejects delayMs <= 0. The
   * form has to say so itself rather than let the save come back as a 500 with the registry's wording.
   */
  // The seeded moment is already in the past (scheduledAt 48h ago + a 1h delay), so saving the job
  // untouched is the case a user hits by opening an overdue job and pressing Save.
  it('refuses a moment in the past, naming the field', async () => {
    const onSubmit = renderForm({ ...EXISTING_ONCE });

    save();

    await waitFor(() => expect(screen.getByText(/must be in the future/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an empty moment', async () => {
    const onSubmit = renderForm({ ...EXISTING_ONCE });

    fireEvent.change(dateInput(), { target: { value: '' } });
    save();

    await waitFor(() => expect(screen.getByText(/A moment is required/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('other job types are untouched', () => {
  it('a cron job form has no moment field and still saves', async () => {
    const onSubmit = renderForm({
      id: 'c1', type: 'cron', label: 'Nightly', command: 'echo tick', schedule: '0 3 * * *',
    });
    expect(screen.queryByLabelText(/^Run at/)).toBeNull();

    save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const data = onSubmit.mock.calls[0]![0] as Partial<Job>;
    expect(data.scheduledAt).toBeUndefined();
    expect(data.delayMs).toBeUndefined();
  });

  it('a startup job keeps its own delaySeconds field', () => {
    renderForm({ id: 's1', type: 'startup', label: 'Boot', command: 'echo boot' });
    expect(screen.getByLabelText(/Delay \(seconds\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Run at/)).toBeNull();
  });
});
