import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';

// Covers JobForm's own contract: a caller that awaits the save and rejects must see why.
//
// Not the fix for the reported "Save does nothing" -- I first believed it was, wrongly. Under the
// DSL the brain owns the HTTP call, so the onSubmit JobForm receives never rejects and none of this
// runs. That failure is lost in dsl-renderer's useBrains, whose sole call site of runBrain ends in
// `.catch(console.error)` with no way for the page to observe it. These tests still earn their place:
// without them a direct consumer's rejected save leaves the form silent.
function renderForm(onSubmit: (data: unknown) => Promise<void>) {
  return render(
    <MemoryRouter>
      <JobForm
        onSubmit={onSubmit}
        onCancel={() => {}}
        initial={{ id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *' }}
      />
    </MemoryRouter>,
  );
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save' });
}

describe('JobForm save failures', () => {
  it('shows the error when the save is rejected', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('Daemon RPC error 500: nope'));
    renderForm(onSubmit);

    saveButton().click();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    // The cause has to be visible: "something went wrong" sends the reader to the logs.
    expect(screen.getByRole('alert').textContent).toContain('nope');
  });

  it('re-enables the button, so the save can be retried', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'));
    renderForm(onSubmit);

    saveButton().click();

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(saveButton()).not.toBeDisabled();
  });

  it('does not swallow the failure by leaving the form looking untouched', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('boom'));
    renderForm(onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // The whole complaint: the click produced no visible consequence at all.
    expect(screen.queryByRole('alert')).not.toBeNull();
  });

  it('clears a previous error when a later save succeeds', async () => {
    const onSubmit = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    renderForm(onSubmit);

    saveButton().click();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    saveButton().click();
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('shows nothing when the save succeeds', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

/*
 * The daemon's own contract, which this form did not satisfy. Found by deploying locally and
 * clicking Save: the request came back 500 "Job id must be a non-empty string", so creating a job
 * from the dashboard was impossible - and the only trace was a console line, because the DSL brain
 * owns the request and useBrains drops the rejection.
 *
 * registry.ts validateJob() requires a non-empty `id` of at most 128 chars on every job, and a
 * positive integer `delayMs` on a `once` job. Neither was ever sent. The form had no id field
 * before the dsl-ui migration either, so this is not a regression from it - the feature never
 * worked.
 */
function renderNewForm(onSubmit: (data: unknown) => Promise<void>) {
  return render(
    <MemoryRouter>
      <JobForm onSubmit={onSubmit} onCancel={() => {}} />
    </MemoryRouter>,
  );
}

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('JobForm sends what the daemon requires', () => {
  it('asks for an id when creating, since the daemon rejects a job without one', () => {
    renderNewForm(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByLabelText(/^Id/)).toBeInTheDocument();
  });

  it('refuses to submit without an id rather than letting the daemon 500', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Label/, 'My job');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(screen.getByText('Id is required')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends the id for a new cron job', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'my-job');
    fill(/^Label/, 'My job');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({ id: 'my-job', type: 'cron' });
  });

  // 128 is the daemon's limit. Rejecting here names the field; rejecting there is a 500 the page
  // never shows.
  it('rejects an id longer than the daemon accepts', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'x'.repeat(129));
    fill(/^Label/, 'My job');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(screen.getByText(/128 characters/)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // A `once` job needs delayMs > 0 as well. That was the second 500, hiding behind the first.
  it('sends a positive delayMs for a once job', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'one-shot');
    fill(/^Label/, 'One shot');
    fill(/^Command/, 'node --version');
    fill(/^Type/, 'once');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as { delayMs?: number; type?: string };
    expect(sent.type).toBe('once');
    expect(Number.isInteger(sent.delayMs)).toBe(true);
    expect(sent.delayMs).toBeGreaterThan(0);
  });

  // The id is the registry key and the route parameter, so editing it would address a different
  // job. The PUT route takes it from the URL and ignores the body.
  it('does not offer to change the id when editing', () => {
    render(
      <MemoryRouter>
        <JobForm
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onCancel={() => {}}
          initial={{ id: 'existing', type: 'cron', command: 'node -v', label: 'Existing', schedule: '0 9 * * *' }}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByLabelText(/^Id/)).toBeNull();
  });
});
