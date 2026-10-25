import React from 'react';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';
import type { Job } from '../types.js';

// The restart policy (`restartOnExit`) on the job form: a switch, then the strategy and the numeric options, with the
// daemon's defaults as placeholders, its refusals shown by name, and the one combination it refuses (a retry list)
// explained instead of sent.
type Submitted = Partial<Job> & { unset?: string[] };

const EXISTING: Partial<Job> = {
  id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *',
};

function renderForm(initial: Partial<Job> | undefined, onSubmit: (data: unknown) => Promise<void>, onCancel: () => void = () => {}) {
  return render(
    <MemoryRouter>
      <JobForm onSubmit={onSubmit} onCancel={onCancel} initial={initial} />
    </MemoryRouter>,
  );
}

const sent = (onSubmit: ReturnType<typeof vi.fn>): Submitted => onSubmit.mock.calls[0]![0] as Submitted;
const restartSwitch = (): HTMLElement => screen.getByRole('switch', { name: /Restart on exit/ });
const flip = (): void => {
  fireEvent.click(restartSwitch());
};
const fill = (label: RegExp, value: string): void => {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
};
const save = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('JobForm restart policy: the switch', () => {
  it('is off for a job without a policy, and shows no option', () => {
    renderForm(EXISTING, vi.fn().mockResolvedValue(undefined));

    expect(restartSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText(/^Strategy/)).toBeNull();
    expect(screen.queryByLabelText(/^Max restarts/)).toBeNull();
  });

  it('sends nothing, not even an unset, when it was never touched', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
    expect(sent(onSubmit)).not.toHaveProperty('unset');
  });

  it('sends true when switched on with every box empty', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toBe(true);
  });

  it('works on the create form too', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    fill(/^Id/, 'web');
    fill(/^Label/, 'Web');
    fill(/^Command/, 'node server.js');
    fill(/^Schedule/, '0 9 * * *');
    flip();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toBe(true);
    expect(sent(onSubmit)).not.toHaveProperty('unset');
  });

  it('sends no unset when it is switched on and off again on a job that had no policy', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    flip();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
    expect(sent(onSubmit)).not.toHaveProperty('unset');
  });
});

describe('JobForm restart policy: the options', () => {
  it('shows the daemon defaults as placeholders and explains the strategy', () => {
    renderForm(EXISTING, vi.fn().mockResolvedValue(undefined));
    flip();

    expect(screen.getByLabelText(/^Strategy/)).toHaveValue('exponential');
    expect(screen.getByLabelText(/^Initial delay/)).toHaveAttribute('placeholder', '1');
    expect(screen.getByLabelText(/^Factor/)).toHaveAttribute('placeholder', '2');
    expect(screen.getByLabelText(/^Max delay/)).toHaveAttribute('placeholder', '30');
    expect(screen.getByLabelText(/^Max restarts/)).toHaveAttribute('placeholder', '10');
    expect(screen.getByLabelText(/^Window/)).toHaveAttribute('placeholder', '300');
    expect(screen.getByLabelText(/^Stable after/)).toHaveAttribute('placeholder', '900');
    expect(screen.getByText(/multiplied by the factor/)).toBeInTheDocument();
  });

  it('shows only the options the chosen strategy reads', () => {
    renderForm(EXISTING, vi.fn().mockResolvedValue(undefined));
    flip();
    expect(screen.queryByLabelText(/^Step/)).toBeNull();

    fill(/^Strategy/, 'linear');
    expect(screen.getByLabelText(/^Step/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^Factor/)).toBeNull();
    expect(screen.getByLabelText(/^Max delay/)).toBeInTheDocument();
    // The step defaults to the initial delay, and says so.
    expect(screen.getByLabelText(/^Step/)).toHaveAttribute('placeholder', '1');
    fill(/^Initial delay/, '4');
    expect(screen.getByLabelText(/^Step/)).toHaveAttribute('placeholder', '4');

    fill(/^Strategy/, 'fixed');
    expect(screen.queryByLabelText(/^Step/)).toBeNull();
    expect(screen.queryByLabelText(/^Factor/)).toBeNull();
    expect(screen.queryByLabelText(/^Max delay/)).toBeNull();
    expect(screen.getByLabelText(/^Initial delay/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Max restarts/)).toBeInTheDocument();
  });

  it('sends only the boxes filled in, and the strategy only when it is not the default', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Strategy/, 'linear');
    fill(/^Step/, '2');
    fill(/^Max restarts/, '5');

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toEqual({ strategy: 'linear', stepSeconds: 2, maxRestarts: 5 });
  });

  it('drops a value typed for an option the final strategy does not read', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Factor/, '3');
    fill(/^Strategy/, 'fixed');

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    // A factor on a fixed policy is refused by the daemon; it must not even be sent.
    expect(sent(onSubmit).restartOnExit).toEqual({ strategy: 'fixed' });
  });
});

describe('JobForm restart policy: refusals are shown, never silent', () => {
  it('names the daemon refusal on the field and sends nothing', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Factor/, '1');

    save();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('restartOnExit.factor must be a number above 1');
    expect(screen.getByLabelText(/^Factor/)).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a fractional restart count with the daemon sentence', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Max restarts/, '2.5');

    save();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('restartOnExit.maxRestarts must be a whole number of at least 1 (got: 2.5)');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses an initial delay above the default ceiling and says the ceiling is the default', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Initial delay/, '45');

    save();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('restartOnExit.initialDelaySeconds (45) is above restartOnExit.maxDelaySeconds (30, the default)');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('drops the refusal once the value is fixed, and then saves', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Max restarts/, '0');
    save();
    await screen.findByRole('alert');

    fill(/^Max restarts/, '3');
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(sent(onSubmit).restartOnExit).toEqual({ maxRestarts: 3 });
  });

  it('ignores the boxes while the switch is off', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);
    flip();
    fill(/^Factor/, '1');
    flip();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
  });
});

describe('JobForm restart policy: the timeout note', () => {
  it('says that the default 300 s timeout restarts the job every 5 minutes, and what to do', () => {
    renderForm(EXISTING, vi.fn().mockResolvedValue(undefined));
    expect(screen.queryByText(/300 s timeout/)).toBeNull();

    flip();

    expect(screen.getByText(/300 s timeout/).textContent).toMatch(/every 5 minutes/);
    expect(screen.getByText(/300 s timeout/).textContent).toMatch(/timeout 0/);
  });

  it('warns with the job own timeout, and calms down once the timeout is 0', () => {
    renderForm({ ...EXISTING, timeoutSeconds: 60 }, vi.fn().mockResolvedValue(undefined));
    flip();
    expect(screen.getByRole('status').textContent).toContain('60 s');

    fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }));
    fill(/^Timeout/, '0');

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not warn for a job already declared without a timeout', () => {
    renderForm({ ...EXISTING, timeoutSeconds: 0 }, vi.fn().mockResolvedValue(undefined));
    flip();

    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('JobForm restart policy: editing a job that has one', () => {
  it('loads true as on, with the boxes empty, and saves it unchanged', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...EXISTING, restartOnExit: true }, onSubmit);

    expect(restartSwitch()).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText(/^Max restarts/)).toHaveValue(null);

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toBe(true);
  });

  it('loads every value of the object and saves it unchanged', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const policy = { strategy: 'linear' as const, initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 20, maxRestarts: 4, windowSeconds: 120, stableAfterSeconds: 600 };
    renderForm({ ...EXISTING, restartOnExit: policy }, onSubmit);

    expect(screen.getByLabelText(/^Strategy/)).toHaveValue('linear');
    expect(screen.getByLabelText(/^Initial delay/)).toHaveValue(2);
    expect(screen.getByLabelText(/^Step/)).toHaveValue(3);
    expect(screen.getByLabelText(/^Max delay/)).toHaveValue(20);
    expect(screen.getByLabelText(/^Max restarts/)).toHaveValue(4);
    expect(screen.getByLabelText(/^Window/)).toHaveValue(120);
    expect(screen.getByLabelText(/^Stable after/)).toHaveValue(600);

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toEqual(policy);
  });

  it('keeps an explicit default strategy explicit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...EXISTING, restartOnExit: { strategy: 'exponential', maxRestarts: 3 } }, onSubmit);

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).restartOnExit).toEqual({ strategy: 'exponential', maxRestarts: 3 });
  });

  it('turns the policy off through unset, never through the body', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...EXISTING, restartOnExit: true }, onSubmit);
    flip();

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).unset).toEqual(['restartOnExit']);
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
  });

  it('sends no unset for a stored false that stays off', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...EXISTING, restartOnExit: false }, onSubmit);

    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit)).not.toHaveProperty('unset');
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
  });
});

describe('JobForm restart policy: the retry list conflict', () => {
  const RETRYING: Partial<Job> = { ...EXISTING, retryOnExitCodes: [1], retryDelays: [5, 10] };

  it('locks the switch and explains what to clear, with the command', () => {
    renderForm(RETRYING, vi.fn().mockResolvedValue(undefined));

    expect(restartSwitch()).toHaveAttribute('data-disabled');
    const note = screen.getByText(/retryOnExitCodes\/retryDelays/);
    expect(note.textContent).toContain('orch edit j1 --unset retryOnExitCodes,retryDelays');
  });

  it('does not turn on when clicked, and saves without touching the retry list', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(RETRYING, onSubmit);

    fireEvent.click(restartSwitch());
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(restartSwitch()).toHaveAttribute('aria-checked', 'false');
    expect(sent(onSubmit)).not.toHaveProperty('restartOnExit');
    expect(sent(onSubmit)).not.toHaveProperty('unset');
  });

  it('is not triggered by an empty retry list', () => {
    renderForm({ ...EXISTING, retryOnExitCodes: [], retryDelays: [] }, vi.fn().mockResolvedValue(undefined));

    expect(restartSwitch()).not.toHaveAttribute('data-disabled');
  });

  it('refuses to save a job that already has both, names the conflict, and lets the policy be switched off', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...RETRYING, restartOnExit: true }, onSubmit);

    save();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('cannot be used on the same job');
    expect(onSubmit).not.toHaveBeenCalled();

    // The way out the form can offer itself: switch the policy off.
    expect(restartSwitch()).not.toHaveAttribute('data-disabled');
    flip();
    save();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(sent(onSubmit).unset).toEqual(['restartOnExit']);
  });
});

// Cancel must only cancel: dsl-ui's ButtonCancel has no type, so inside a form it submitted the edits (a past bug).
describe('JobForm restart policy: Cancel', () => {
  it('saves nothing after the policy was edited, and cancels once', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    const { container } = renderForm({ ...EXISTING, restartOnExit: { maxRestarts: 3 } }, onSubmit, onCancel);
    const submitEvent = vi.fn();
    container.querySelector('form')!.addEventListener('submit', submitEvent);
    fill(/^Max restarts/, '7');
    flip();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(async () => {});

    expect(submitEvent).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not submit when the switch itself is clicked', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(EXISTING, onSubmit);

    flip();
    await act(async () => {});

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
