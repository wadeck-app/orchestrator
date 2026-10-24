import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';
import { PROGRESS_MODES } from '../progress-modes.js';
import type { Job, JobFormPayload } from '../types.js';

const BASE: Partial<Job> = { id: 'j1', type: 'cron', command: 'node -v', label: 'Original', schedule: '0 9 * * *' };

function renderForm(initial: Partial<Job> | undefined, onSubmit: (d: JobFormPayload) => Promise<void> = async () => {}) {
  return render(
    <MemoryRouter>
      <JobForm initial={initial ?? BASE} onSubmit={onSubmit} onCancel={() => {}} />
    </MemoryRouter>,
  );
}

function openSection() {
  fireEvent.click(screen.getByRole('button', { name: /Progress/ }));
}

function pickMode(value: string) {
  fireEvent.change(screen.getByLabelText('Progress mode'), { target: { value } });
}

async function save(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
}

describe('JobForm progress section', () => {
  it('is collapsed by default and does not show the mode select', () => {
    renderForm(undefined);
    expect(screen.getByRole('button', { name: /Progress/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Progress mode')).toBeNull();
  });

  it('opens with a mode select offering every mode', () => {
    renderForm(undefined);
    openSection();
    const select = screen.getByLabelText('Progress mode') as HTMLSelectElement;
    expect([...select.options].map(o => o.value)).toEqual(PROGRESS_MODES.map(m => m.id));
  });

  it('is open on a job that already has a progress setting', () => {
    renderForm({ ...BASE, progress: 'history' });
    expect((screen.getByLabelText('Progress mode') as HTMLSelectElement).value).toBe('history');
  });

  it('shows the one-line explanation of the chosen mode', () => {
    renderForm(undefined);
    openSection();
    pickMode('off');
    const off = PROGRESS_MODES.find(m => m.id === 'off')!;
    expect(screen.getByText(off.explanation)).toBeInTheDocument();
    pickMode('history');
    expect(screen.queryByText(off.explanation)).toBeNull();
    expect(screen.getByText(PROGRESS_MODES.find(m => m.id === 'history')!.explanation)).toBeInTheDocument();
  });

  it('shows the options box only for strategies that take options, with an example', () => {
    renderForm(undefined);
    openSection();
    for (const id of ['auto', 'off', 'history', 'ensemble']) {
      pickMode(id);
      expect(screen.queryByLabelText(/Progress options/), id).toBeNull();
    }
    pickMode('ratio');
    const box = screen.getByLabelText(/Progress options/);
    expect(box).toBeInTheDocument();
    expect(screen.getByText(`Example: ${PROGRESS_MODES.find(m => m.id === 'ratio')!.optionsExample}`)).toBeInTheDocument();
  });

  it('sends nothing for auto on a new job', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...BASE, id: undefined }, onSubmit);
    fireEvent.change(screen.getByLabelText(/^Id/), { target: { value: 'new-job' } });
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0]![0] as JobFormPayload;
    expect(payload.progress).toBeUndefined();
    expect(payload.unset ?? []).not.toContain('progress');
  });

  it('sends a strategy without options as its id', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('history');
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as JobFormPayload).progress).toBe('history');
  });

  it('sends off as off', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('off');
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as JobFormPayload).progress).toBe('off');
  });

  it('sends { strategy, options } when options are given', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('ratio');
    fireEvent.change(screen.getByLabelText(/Progress options/), { target: { value: '{"pattern": "(\\\\d+)/(\\\\d+)"}' } });
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as JobFormPayload).progress).toEqual({ strategy: 'ratio', options: { pattern: '(\\d+)/(\\d+)' } });
  });

  it('sends the bare id when an optional options box is left empty', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('declared');
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as JobFormPayload).progress).toBe('declared');
  });

  it('refuses invalid JSON inline and does not submit', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('ratio');
    fireEvent.change(screen.getByLabelText(/Progress options/), { target: { value: '{"pattern": ' } });
    await save();
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('refuses a JSON value that is not an object', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('ratio');
    fireEvent.change(screen.getByLabelText(/Progress options/), { target: { value: '[1]' } });
    await save();
    expect(await screen.findByText(/must be a JSON object/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('requires options for the strategies that cannot work without them', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('log-declared');
    await save();
    expect(await screen.findByText(/needs options/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('opens the collapsed section when its validation fails', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...BASE, progress: { strategy: 'ratio', options: { pattern: '(\\d+)%' } } }, onSubmit);
    fireEvent.change(screen.getByLabelText(/Progress options/), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /Progress/ }));
    expect(screen.queryByLabelText('Progress mode')).toBeNull();
    await save();
    expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
  });

  it('prefills mode and options when editing', () => {
    renderForm({ ...BASE, progress: { strategy: 'ratio', options: { pattern: '(\\d+)%' } } });
    expect((screen.getByLabelText('Progress mode') as HTMLSelectElement).value).toBe('ratio');
    expect(JSON.parse((screen.getByLabelText(/Progress options/) as HTMLTextAreaElement).value)).toEqual({ pattern: '(\\d+)%' });
  });

  it('unsets progress when a configured job goes back to auto', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm({ ...BASE, progress: 'history' }, onSubmit);
    pickMode('auto');
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const payload = onSubmit.mock.calls[0]![0] as JobFormPayload;
    expect(payload.progress).toBeUndefined();
    expect(payload.unset).toContain('progress');
  });

  it('does not unset anything when auto was already the setting', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(undefined, onSubmit);
    await save();
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect((onSubmit.mock.calls[0]![0] as JobFormPayload).unset ?? []).not.toContain('progress');
  });

  it('shows the daemon message when the save is rejected on the progress setting', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('progress: unknown strategy "foo". Registered: history, ratio'));
    renderForm(undefined, onSubmit);
    openSection();
    pickMode('history');
    await save();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('unknown strategy "foo"');
  });
});
