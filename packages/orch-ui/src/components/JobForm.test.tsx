import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';
import type { Job } from '../types.js';

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

/*
 * Clearing a field in the form used to be a no-op. An edit is a PATCH: `if (cwd.trim())
 * data.cwd = ...` simply omitted the key, and an omitted key tells the daemon "leave it alone".
 * The user emptied the box, hit Save, saw no error, and the old value was still there.
 *
 * `PUT /api/jobs/:id` already takes an `unset` array beside the changed fields, which the server
 * lifts out of the body and hands to registry.edit(). These tests pin the form to that contract.
 */
type SubmittedPayload = Partial<Job> & { unset?: string[] };

function renderEditForm(initial: Partial<Job>, onSubmit: (data: unknown) => Promise<void>) {
  return render(
    <MemoryRouter>
      <JobForm onSubmit={onSubmit} onCancel={() => {}} initial={initial} />
    </MemoryRouter>,
  );
}

function submitted(onSubmit: ReturnType<typeof vi.fn>): SubmittedPayload {
  return onSubmit.mock.calls[0]![0] as SubmittedPayload;
}

// fireEvent, not a bare .click(): the advanced block only exists after the state update is flushed,
// and the queries below run synchronously right after this call.
function showAdvanced(): void {
  fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }));
}

const EXISTING_CRON: Partial<Job> = {
  id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *',
};

describe('JobForm clears fields the user emptied', () => {
  it('sends cwd in unset, and not in the body, when an existing cwd is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, cwd: 'C:/work' }, onSubmit);

    fill(/^Working directory/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['cwd']);
    // Both would be a contradiction, and registry.edit() rejects it outright.
    expect(sent).not.toHaveProperty('cwd');
  });

  it('leaves an untouched cwd in the body and out of unset', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, cwd: 'C:/work' }, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.cwd).toBe('C:/work');
    expect(sent).not.toHaveProperty('unset');
  });

  it('omits unset entirely when a field was empty before and after', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // An empty array would still travel to the daemon and read as an edit that clears nothing.
    expect(submitted(onSubmit)).not.toHaveProperty('unset');
  });

  it('never sends unset when creating, since there is no stored value to clear', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'my-job');
    fill(/^Label/, 'My job');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit)).not.toHaveProperty('unset');
  });

  it('refuses to clear a required command instead of unsetting it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Command/, '');
    saveButton().click();

    await waitFor(() => expect(screen.getByText('Command is required')).toBeInTheDocument());
    // The daemon cannot run a job without a command, so `unset` is not an option here.
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses to clear a required schedule instead of unsetting it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Schedule/, '');
    saveButton().click();

    await waitFor(() => expect(screen.getByText(/Schedule/)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // label IS unsettable in the daemon, but it resets to the job id rather than disappearing, and
  // the form declares it required. Required wins: the user gets told, not silently renamed.
  it('refuses to clear the label instead of unsetting it', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Label/, '');
    saveButton().click();

    await waitFor(() => expect(screen.getByText('Label is required')).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('sends tags in unset when every tag is removed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, tags: ['daily', 'scraper'] }, onSubmit);

    fill(/^Tags/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['tags']);
    expect(sent).not.toHaveProperty('tags');
  });

  // 0 is not "no timeout" to the daemon: isEmptyValue() keeps 0, so the body would store a job that
  // times out instantly. Clearing the box has to mean unset.
  it('sends timeoutSeconds in unset when the timeout is zeroed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, timeoutSeconds: 600 }, onSubmit);

    showAdvanced();
    fill(/^Timeout/, '0');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['timeoutSeconds']);
    expect(sent).not.toHaveProperty('timeoutSeconds');
  });

  // These three were left out when unset was first wired up, because the daemon rejected them:
  // UNSETTABLE_FIELDS had no entry for them. It does now, so emptying them has to reach it.
  it('sends dependsOn in unset when the dependency is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, dependsOn: 'other-job' }, onSubmit);

    showAdvanced();
    fill(/^Run after job/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['dependsOn']);
    expect(sent).not.toHaveProperty('dependsOn');
  });

  it('sends slaWindowMinutes in unset when the SLA window is zeroed', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, slaWindowMinutes: 30 }, onSubmit);

    showAdvanced();
    fill(/^SLA window/, '0');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['slaWindowMinutes']);
    expect(sent).not.toHaveProperty('slaWindowMinutes');
  });

  // 0 and false are values the daemon keeps, so "already off" must not look like "just turned off":
  // saving an unchanged job would otherwise send an unset on every submit.
  it('sends nothing for an SLA window that was already 0', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, slaWindowMinutes: 0 }, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset ?? []).not.toContain('slaWindowMinutes');
  });

  it('sends dryRunSupported in unset when the box is unticked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, dryRunSupported: true }, onSubmit);

    showAdvanced();
    fireEvent.click(screen.getByLabelText(/Supports dry run/));
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['dryRunSupported']);
    expect(sent).not.toHaveProperty('dryRunSupported');
  });

  it('sends nothing for a dry-run flag that was already off', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, dryRunSupported: false }, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset ?? []).not.toContain('dryRunSupported');
  });

  it('sends env in unset when the last variable name is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, env: { TOKEN: 'abc' } }, onSubmit);

    showAdvanced();
    fill(/^Environment variable key/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['env']);
    expect(sent).not.toHaveProperty('env');
  });

  it('sends onExitCode in unset when the last exit code is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, onExitCode: { '2': 'locked' } }, onSubmit);

    showAdvanced();
    fill(/^Exit code$/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['onExitCode']);
    expect(sent).not.toHaveProperty('onExitCode');
  });

  // Changing the type takes the delay field off the form. Left alone, the patch keeps a delaySeconds
  // that now belongs to no type.
  it('sends delaySeconds in unset when a startup job becomes a cron job', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ id: 'j2', type: 'startup', command: 'node -v', label: 'Boot', delaySeconds: 30 }, onSubmit);

    fill(/^Type/, 'cron');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['delaySeconds']);
    expect(sent).not.toHaveProperty('delaySeconds');
  });

  // liveness is unsettable, but the form already sends `liveness: null` and normalizeJob() drops an
  // empty value on every write. Naming it in `unset` too would be the forbidden set-and-unset.
  it('clears liveness through the body, never through unset', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'portFile', portFile: '/tmp/a.port' } }, onSubmit);

    showAdvanced();
    fill(/^Liveness check/, 'none');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.liveness).toBeNull();
    expect(sent).not.toHaveProperty('unset');
  });

  // retryOnExitCodes, retryDelays and skipExitCodes are unsettable in the daemon but absent from
  // this form. Unsetting what the user was never shown would delete config behind their back.
  it('never unsets retry or skip config the form does not edit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, cwd: 'C:/work' }, onSubmit);

    fill(/^Working directory/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).unset).toEqual(['cwd']);
  });

  it('collects every emptied field into one unset array', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, cwd: 'C:/work', tags: ['daily'] }, onSubmit);

    fill(/^Working directory/, '');
    fill(/^Tags/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).unset).toEqual(expect.arrayContaining(['cwd', 'tags']));
    expect(submitted(onSubmit).unset).toHaveLength(2);
  });
});
