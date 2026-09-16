import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
