import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';
import type { Job } from '../types.js';
import { createDateFormatter, DEFAULT_DATE_SETTINGS } from '@wadeck-app/dsl-ui';

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

  /*
   * A `once` job needs delayMs > 0 as well. That was the second 500, hiding behind the first.
   *
   * The form asks for the moment now rather than a number of seconds, so the moment has to be chosen:
   * it no longer defaults to one second from now, which was a value nobody meant and which made a
   * mis-saved job fire immediately. scheduledAt goes with it -- see the comment on the submit path for
   * why sending delayMs alone would fire at the wrong time on an edit.
   */
  it('sends a positive delayMs and a fresh scheduledAt for a once job', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'one-shot');
    fill(/^Label/, 'One shot');
    fill(/^Command/, 'node --version');
    fill(/^Type/, 'once');
    fill(/^Run at/, createDateFormatter(DEFAULT_DATE_SETTINGS).format(new Date(2099, 11, 31), 'medium', 'date'));
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as { delayMs?: number; type?: string; scheduledAt?: string };
    expect(sent.type).toBe('once');
    expect(Number.isInteger(sent.delayMs)).toBe(true);
    expect(sent.delayMs).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(sent.scheduledAt ?? ''))).toBe(true);
  });

  it('refuses to create a once job with no moment, rather than inventing one', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'one-shot');
    fill(/^Label/, 'One shot');
    fill(/^Command/, 'node --version');
    fill(/^Type/, 'once');
    saveButton().click();

    await waitFor(() => expect(screen.getByText(/A moment is required/i)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  /*
   * The active period: "active for three weeks", or one that starts later. The daemon disables the
   * job at the end rather than deleting it.
   *
   * The field only exists for cron jobs, so the whole feature was unreachable from the dashboard until
   * it was added here - the daemon accepted activeFrom/activeUntil and nothing could send them.
   */
  it('offers an active period for a cron job', () => {
    renderNewForm(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByText(/Active period/)).toBeInTheDocument();
  });

  it('offers a preset for three weeks, which is the case asked for', () => {
    renderNewForm(vi.fn().mockResolvedValue(undefined));
    expect(screen.getByRole('button', { name: '3 weeks' })).toBeInTheDocument();
  });

  it('sends the period as ISO timestamps when a preset is used', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'windowed');
    fill(/^Label/, 'Windowed');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    fireEvent.click(screen.getByRole('button', { name: '3 weeks' }));
    // Waited on, not just clicked: React batches per event, so submitting in the same synchronous
    // block would close over the state from before the preset was applied. The Clear chip only exists
    // once a period is set, so its appearance is the state having landed.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument());
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as { activeFrom?: string; activeUntil?: string };
    expect(typeof sent.activeFrom).toBe('string');
    expect(typeof sent.activeUntil).toBe('string');
    const days = (new Date(sent.activeUntil!).getTime() - new Date(sent.activeFrom!).getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(21);
  });

  it('sends no period when none is chosen, so the job runs indefinitely', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'unbounded');
    fill(/^Label/, 'Unbounded');
    fill(/^Command/, 'node --version');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // Named rather than Record<string, unknown>: these two fields being absent is the assertion,
    // so they belong in the type instead of being looked up on an index signature.
    const sent = onSubmit.mock.calls[0]![0] as { activeFrom?: unknown; activeUntil?: unknown };
    expect(sent.activeFrom).toBeUndefined();
    expect(sent.activeUntil).toBeUndefined();
  });

  // An edit showing an empty field would clear the window the job already has.
  it('shows the period a job already has when editing', () => {
    const from = '2026-03-01T00:00:00.000Z';
    const until = '2026-03-22T00:00:00.000Z';
    render(
      <MemoryRouter>
        <JobForm
          onSubmit={vi.fn().mockResolvedValue(undefined)}
          onCancel={() => {}}
          initial={{
            id: 'w', type: 'cron', command: 'node -v', label: 'W', schedule: '0 9 * * *',
            activeFrom: from, activeUntil: until,
          }}
        />
      </MemoryRouter>,
    );

    // A Clear chip only appears once a period is set, so its presence is the period being shown.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument();
  });

  // An edit is a PATCH, so an omitted key means "leave it alone" - clearing has to travel as an unset.
  it('unsets the period when it is cleared on an edit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <JobForm
          onSubmit={onSubmit}
          onCancel={() => {}}
          initial={{
            id: 'w', type: 'cron', command: 'node -v', label: 'W', schedule: '0 9 * * *',
            activeFrom: '2026-03-01T00:00:00.000Z', activeUntil: '2026-03-22T00:00:00.000Z',
          }}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    // The chip disappears once the period is empty, which is the state change flushing.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull());
    fireEvent.click(saveButton());

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as { unset?: string[] };
    expect(sent.unset).toContain('activeFrom');
    expect(sent.unset).toContain('activeUntil');
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

  // 0 is a value: "no timeout", for a process that must stay up. Reading it as "unset" put the job
  // back on the 300s default, so the one setting that exists for a long-running job was undone by
  // saving the form.
  it('sends a zero timeout as a value, not as unset', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, timeoutSeconds: 600 }, onSubmit);

    showAdvanced();
    fill(/^Timeout/, '0');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.timeoutSeconds).toBe(0);
    expect(sent).not.toHaveProperty('unset');
  });

  // An emptied box is the absence of a choice, which is what unset means. It must not read as 0,
  // which would silently remove the timeout.
  it('sends timeoutSeconds in unset when the timeout box is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, timeoutSeconds: 600 }, onSubmit);

    showAdvanced();
    fill(/^Timeout/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['timeoutSeconds']);
    expect(sent).not.toHaveProperty('timeoutSeconds');
  });

  it('sends maxConcurrency when a limit is entered', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    showAdvanced();
    fill(/^Max concurrent runs/, '1');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).maxConcurrency).toBe(1);
  });

  it('sends maxConcurrency in unset when the limit is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, maxConcurrency: 2 }, onSubmit);

    showAdvanced();
    fill(/^Max concurrent runs/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent.unset).toEqual(['maxConcurrency']);
    expect(sent).not.toHaveProperty('maxConcurrency');
  });

  it('leaves maxConcurrency out when no limit was ever set', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = submitted(onSubmit);
    expect(sent).not.toHaveProperty('maxConcurrency');
    expect(sent).not.toHaveProperty('unset');
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

  // Rebuilding liveness without the timeout would put the job back on the 30 s default on every save, without a word:
  // the box is seeded from the job, so a save that touches nothing sends it back.
  it('keeps the liveness command timeout, loaded into its box', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it', timeoutSeconds: 90 } }, onSubmit);

    showAdvanced();
    expect(screen.getByLabelText(/^Liveness timeout/)).toHaveValue(90);
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).liveness).toEqual({ strategy: 'command', command: 'check-it', timeoutSeconds: 90 });
  });

  it('sends the typed liveness timeout as a number', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it' } }, onSubmit);

    showAdvanced();
    fill(/^Liveness timeout/, '120');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).liveness).toEqual({ strategy: 'command', command: 'check-it', timeoutSeconds: 120 });
  });

  // Emptied on purpose: the box says 30 in its placeholder, so leaving the key out is the visible choice of the default.
  it('sends no liveness timeout when its box is emptied, and says the default in the placeholder', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it', timeoutSeconds: 90 } }, onSubmit);

    showAdvanced();
    expect(screen.getByLabelText(/^Liveness timeout/)).toHaveAttribute('placeholder', '30');
    fill(/^Liveness timeout/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).liveness).toEqual({ strategy: 'command', command: 'check-it' });
  });

  it('shows the liveness timeout box only for the command strategy', () => {
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'portFile', portFile: '/tmp/a.port' } }, vi.fn());

    showAdvanced();
    expect(screen.queryByLabelText(/^Liveness timeout/)).toBeNull();
    fill(/^Liveness check/, 'command');
    expect(screen.getByLabelText(/^Liveness timeout/)).toBeInTheDocument();
  });

  it.each(['0', '3601', '2.5', '-4'])('refuses the liveness timeout %s on the field, with the daemon sentence, and sends nothing', async (value) => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it' } }, onSubmit);

    showAdvanced();
    fill(/^Liveness timeout/, value);
    saveButton().click();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('liveness.timeoutSeconds must be a whole number of seconds from 1 to 3600');
    expect(alert.textContent).toContain(`got ${value}`);
    expect(screen.getByLabelText(/^Liveness timeout/)).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // The Advanced section starts collapsed: a refusal inside it would be invisible.
  it('opens the Advanced section when the liveness timeout is refused', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it', timeoutSeconds: 9999 } }, onSubmit);

    saveButton().click();

    expect((await screen.findByRole('alert')).textContent).toContain('liveness.timeoutSeconds');
    expect(screen.getByLabelText(/^Liveness timeout/)).toBeInTheDocument();
  });

  it('does not validate a stale timeout once the strategy is no longer command', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it' } }, onSubmit);

    showAdvanced();
    fill(/^Liveness timeout/, '99999');
    fill(/^Liveness check/, 'pidFile');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).liveness).toEqual({ strategy: 'pidFile' });
  });

  it('drops the liveness command timeout when the strategy is no longer command', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, liveness: { strategy: 'command', command: 'check-it', timeoutSeconds: 90 } }, onSubmit);

    showAdvanced();
    fill(/^Liveness check/, 'pidFile');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).liveness).toEqual({ strategy: 'pidFile' });
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

// The description is optional free text, up to 2000 characters. The form refuses an over-long one
// itself, with the number, instead of sending it to be refused by the daemon.
describe('JobForm description', () => {
  it('has a Description field with its hint and a live counter', () => {
    renderEditForm({ ...EXISTING_CRON, description: 'Backs up' }, vi.fn().mockResolvedValue(undefined));

    expect(screen.getByLabelText(/^Description/)).toHaveValue('Backs up');
    expect(screen.getByText('Shown on the job card and the job page. Plain text, up to 2000 characters.')).toBeInTheDocument();
    expect(screen.getByText('8 / 2000')).toBeInTheDocument();
  });

  it('updates the counter as the user types', () => {
    renderEditForm(EXISTING_CRON, vi.fn().mockResolvedValue(undefined));

    fill(/^Description/, 'abc\ndef');

    expect(screen.getByText('7 / 2000')).toBeInTheDocument();
  });

  it('sends the trimmed text, line breaks kept', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Description/, '  first\nsecond  ');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).description).toBe('first\nsecond');
  });

  it('sends nothing for a description the user never wrote', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit)).not.toHaveProperty('description');
    expect(submitted(onSubmit)).not.toHaveProperty('unset');
  });

  it('sends description in unset, and not in the body, when an existing one is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, description: 'old' }, onSubmit);

    fill(/^Description/, '   ');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).unset).toEqual(['description']);
    expect(submitted(onSubmit)).not.toHaveProperty('description');
  });

  it('accepts exactly 2000 characters', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Description/, 'x'.repeat(2000));
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });

  it('refuses 2001 before submit, naming the limit and the length, and sends nothing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Description/, 'x'.repeat(2001));
    saveButton().click();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/2000/);
    expect(alert.textContent).toMatch(/2001/);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('counts the trimmed text, like the daemon', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    fill(/^Description/, `   ${'x'.repeat(2000)}   `);
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  });
});

// Resource limits: a collapsed section, closed unless the job already has some. Empty fields are not sent
// (the daemon's defaults apply); emptying every field clears the whole object through `unset`.
describe('JobForm resource limits', () => {
  const openLimits = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /Resource limits/ }));
  };

  it('is collapsed for a job with no limits, and opens on demand', () => {
    renderEditForm(EXISTING_CRON, vi.fn().mockResolvedValue(undefined));

    expect(screen.getByRole('button', { name: /Resource limits/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText(/^Hard factor/)).toBeNull();

    openLimits();

    expect(screen.getByLabelText(/^Hard factor/)).toBeInTheDocument();
  });

  it('is open, with the values, for a job that has limits', () => {
    renderEditForm({ ...EXISTING_CRON, resourceLimits: { enforce: 'warn', hardFactor: 5, maxRamMb: 512 } }, vi.fn().mockResolvedValue(undefined));

    expect(screen.getByRole('button', { name: /Resource limits/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText(/^Hard factor/)).toHaveValue(5);
    expect(screen.getByLabelText(/^Max RAM/)).toHaveValue(512);
    expect(screen.getByLabelText(/^Enforcement/)).toHaveValue('warn');
  });

  it('shows the daemon defaults as placeholders and explains each enforcement', () => {
    renderEditForm(EXISTING_CRON, vi.fn().mockResolvedValue(undefined));
    openLimits();

    expect(screen.getByLabelText(/^Hard factor/)).toHaveAttribute('placeholder', '3');
    expect(screen.getByLabelText(/^Soft factor/)).toHaveAttribute('placeholder', '1.5');
    expect(screen.getByLabelText(/^Sustain/)).toHaveAttribute('placeholder', '30');
    const select = screen.getByLabelText(/^Enforcement/);
    expect(screen.getByText(/ends a run that stays over its hard limit/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'warn' } });
    expect(screen.getByText(/never ends it/)).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'off' } });
    expect(screen.getByText(/No limit is checked/)).toBeInTheDocument();
  });

  it('sends nothing when the section was never touched', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);

    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit)).not.toHaveProperty('resourceLimits');
    expect(submitted(onSubmit)).not.toHaveProperty('unset');
  });

  it('sends only the fields filled in', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);
    openLimits();

    fireEvent.change(screen.getByLabelText(/^Enforcement/), { target: { value: 'warn' } });
    fill(/^Hard factor/, '4.5');
    fill(/^Sustain/, '60');
    fill(/^Max CPU/, '150');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).resourceLimits).toEqual({ enforce: 'warn', hardFactor: 4.5, sustainSeconds: 60, maxCpuPct: 150 });
  });

  it('does not send the default enforcement on its own', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);
    openLimits();

    fill(/^Max RAM/, '256');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).resourceLimits).toEqual({ maxRamMb: 256 });
  });

  it('sends resourceLimits in unset, and not in the body, when every field of an existing one is emptied', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, resourceLimits: { enforce: 'warn', hardFactor: 5 } }, onSubmit);

    fireEvent.change(screen.getByLabelText(/^Enforcement/), { target: { value: 'kill' } });
    fill(/^Hard factor/, '');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(submitted(onSubmit).unset).toEqual(['resourceLimits']);
    expect(submitted(onSubmit)).not.toHaveProperty('resourceLimits');
  });

  it('refuses invalid values before submit, names each field, opens the section, and sends nothing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);
    openLimits();

    fill(/^Hard factor/, '1');
    fill(/^Soft factor/, '1');
    fill(/^Sustain/, '1');
    fill(/^Max CPU/, '0');
    fill(/^Max RAM/, '-5');
    saveButton().click();

    const alerts = await screen.findAllByRole('alert');
    const text = alerts.map(a => a.textContent).join('\n');
    expect(text).toMatch(/hard factor/i);
    expect(text).toMatch(/soft factor/i);
    expect(text).toMatch(/2 to 3600/);
    expect(text).toMatch(/max cpu/i);
    expect(text).toMatch(/max ram/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('opens a collapsed section when a hidden value is invalid', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm({ ...EXISTING_CRON, resourceLimits: { hardFactor: 5 } }, onSubmit);
    fill(/^Hard factor/, '500');
    fireEvent.click(screen.getByRole('button', { name: /Resource limits/ }));
    expect(screen.queryByLabelText(/^Hard factor/)).toBeNull();

    saveButton().click();

    expect(await screen.findByLabelText(/^Hard factor/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a soft factor not below a hard factor typed in the same form', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);
    openLimits();

    fill(/^Hard factor/, '2');
    fill(/^Soft factor/, '2.5');
    saveButton().click();

    expect((await screen.findByRole('alert')).textContent).toMatch(/below the hard factor \(2\)/);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('JobForm resource limits: feedback and the create form', () => {
  const openLimits = (): void => {
    fireEvent.click(screen.getByRole('button', { name: /Resource limits/ }));
  };

  it('flags only the invalid field, and drops the alert once the value is fixed and saved', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderEditForm(EXISTING_CRON, onSubmit);
    openLimits();

    fill(/^Hard factor/, '1');
    saveButton().click();

    const alert = await screen.findByRole('alert');
    expect(alert.parentElement).toContainElement(screen.getByLabelText(/^Hard factor/));
    expect(screen.getByLabelText(/^Hard factor/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^Soft factor/)).toHaveAttribute('aria-invalid', 'false');
    expect(onSubmit).not.toHaveBeenCalled();

    fill(/^Hard factor/, '4');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(submitted(onSubmit).resourceLimits).toEqual({ hardFactor: 4 });
  });

  it('creates a job with limits: the id, the command and the limits are all sent', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'limited');
    fill(/^Label/, 'Limited');
    fill(/^Command/, 'node -v');
    fill(/^Schedule/, '0 9 * * *');
    openLimits();
    fireEvent.change(screen.getByLabelText(/^Enforcement/), { target: { value: 'warn' } });
    fill(/^Max RAM/, '256');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)).toMatchObject({ id: 'limited', command: 'node -v', resourceLimits: { enforce: 'warn', maxRamMb: 256 } });
    // a new job has nothing to clear
    expect(submitted(onSubmit)).not.toHaveProperty('unset');
  });

  it('creates a job without limits when the section is never opened', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderNewForm(onSubmit);

    fill(/^Id/, 'plain');
    fill(/^Label/, 'Plain');
    fill(/^Command/, 'node -v');
    fill(/^Schedule/, '0 9 * * *');
    saveButton().click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(submitted(onSubmit)).not.toHaveProperty('resourceLimits');
  });
});

// Cancel must only cancel. dsl-ui's ButtonCancel renders a button without a type, which inside a form is a submit
// button: clicking Cancel on the edit page submitted the form (the job was saved with the edits) and then called
// onCancel. Reported by the user as: cancelling an edit still saved it.
describe('JobForm Cancel', () => {
  function renderWith(initial: Job | undefined, onSubmit: (data: unknown) => Promise<void>, onCancel: () => void) {
    return render(
      <MemoryRouter>
        <JobForm onSubmit={onSubmit} onCancel={onCancel} initial={initial} />
      </MemoryRouter>,
    );
  }

  it('does not save the edits of a job, and cancels once', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const { container } = renderWith({ id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *', enabled: true, triggerMode: 'fire-and-forget' }, onSubmit, onCancel);
    // The browser dispatches the submit event synchronously on click, so counting it proves the form was not submitted
    // without waiting for anything.
    const submitted = vi.fn();
    container.querySelector('form')!.addEventListener('submit', submitted);
    fireEvent.change(screen.getByRole('textbox', { name: /^Label/ }), { target: { value: 'Edited, then cancelled' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    // Let every pending promise settle (a validation, then onSubmit) before saying nothing happened.
    await act(async () => {});

    expect(submitted).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not create a job when the new-job form is cancelled', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const { container } = renderWith(undefined, onSubmit, onCancel);
    const submitted = vi.fn();
    container.querySelector('form')!.addEventListener('submit', submitted);
    fireEvent.change(screen.getByRole('textbox', { name: /^Id/ }), { target: { value: 'half-typed' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Label/ }), { target: { value: 'Half typed' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Command/ }), { target: { value: 'node -v' } });
    fireEvent.change(screen.getByRole('textbox', { name: /^Schedule/ }), { target: { value: '0 9 * * *' } });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});

    expect(submitted).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  // Control: the listener above does see a real submit, so "not called" is not a silent pass.
  it('the submit listener does see the Save button submitting', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { container } = renderWith({ id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *', enabled: true, triggerMode: 'fire-and-forget' }, onSubmit, vi.fn());
    const submitted = vi.fn();
    container.querySelector('form')!.addEventListener('submit', submitted);

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {});

    expect(submitted).toHaveBeenCalledTimes(1);
  });
});
