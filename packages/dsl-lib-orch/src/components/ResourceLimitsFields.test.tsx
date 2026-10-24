import React from 'react';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ResourceLimitsFields } from './ResourceLimitsFields.js';
import { ENFORCE_EXPLANATIONS, inputsFromLimits, type ResourceLimitErrors, type ResourceLimitInputs } from '../resource-limits.js';

// The controlled fields of a job's resource limits: accessibility wiring, one error per own field, the explanation
// of the chosen enforcement, and that a change keeps every other input.
const EMPTY = inputsFromLimits(undefined);

function show(inputs: ResourceLimitInputs = EMPTY, errors: ResourceLimitErrors = {}, onChange = vi.fn()) {
  render(<ResourceLimitsFields inputs={inputs} onChange={onChange} errors={errors} />);
  return onChange;
}

const FIELDS = [
  ['hardFactor', /^Hard factor/],
  ['softFactor', /^Soft factor/],
  ['sustainSeconds', /^Sustain time/],
  ['maxCpuPct', /^Max CPU/],
  ['maxRamMb', /^Max RAM/],
] as const;

describe('ResourceLimitsFields accessibility', () => {
  it.each(FIELDS)('%s is not flagged invalid without an error', (_key, label) => {
    show();
    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'false');
  });

  it.each(FIELDS)('%s is flagged invalid, with its message, when it has an error', (key, label) => {
    show(EMPTY, { [key]: `bad ${key}` });

    expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(`bad ${key}`);
  });

  it.each(FIELDS)('%s is described by its own hint', (key, label) => {
    show();

    const input = screen.getByLabelText(label);
    expect(input).toHaveAttribute('aria-describedby', `resource-${key}-hint`);
    const hint = document.getElementById(`resource-${key}-hint`);
    expect(hint).not.toBeNull();
    expect(hint!.textContent!.length).toBeGreaterThan(10);
  });

  it('gives every field a different hint', () => {
    show();
    const hints = FIELDS.map(([key]) => document.getElementById(`resource-${key}-hint`)!.textContent);
    expect(new Set(hints).size).toBe(FIELDS.length);
  });

  it('shows an error next to its own field and nowhere else', () => {
    show(EMPTY, { hardFactor: 'hard is wrong', maxRamMb: 'ram is wrong' });

    const alerts = screen.getAllByRole('alert');
    expect(alerts).toHaveLength(2);
    const ownBlock = (label: RegExp) => screen.getByLabelText(label).parentElement!;
    expect(within(ownBlock(/^Hard factor/)).getByRole('alert')).toHaveTextContent('hard is wrong');
    expect(within(ownBlock(/^Max RAM/)).getByRole('alert')).toHaveTextContent('ram is wrong');
    for (const label of [/^Soft factor/, /^Sustain time/, /^Max CPU/]) {
      expect(within(ownBlock(label)).queryByRole('alert')).toBeNull();
    }
  });

  it('shows no alert at all when there is no error, and drops it when the errors go away', () => {
    const { rerender } = render(<ResourceLimitsFields inputs={EMPTY} onChange={vi.fn()} errors={{ softFactor: 'too high' }} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    rerender(<ResourceLimitsFields inputs={EMPTY} onChange={vi.fn()} errors={{}} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(/^Soft factor/)).toHaveAttribute('aria-invalid', 'false');
  });
});

describe('ResourceLimitsFields enforcement', () => {
  it('offers kill, warn and off with their labels, in that order', () => {
    show();
    const options = within(screen.getByLabelText(/^Enforcement/)).getAllByRole('option');
    expect(options.map(o => [o.getAttribute('value'), o.textContent])).toEqual([
      ['kill', 'Kill'], ['warn', 'Warn only'], ['off', 'Off'],
    ]);
  });

  it.each(['kill', 'warn', 'off'] as const)('explains %s under the select, and only that one', (enforce) => {
    show({ ...EMPTY, enforce });

    expect(screen.getByText(ENFORCE_EXPLANATIONS[enforce])).toBeInTheDocument();
    for (const other of (['kill', 'warn', 'off'] as const).filter(o => o !== enforce)) {
      expect(screen.queryByText(ENFORCE_EXPLANATIONS[other])).toBeNull();
    }
    expect(screen.getByLabelText(/^Enforcement/)).toHaveValue(enforce);
  });

  it('follows the select when it is controlled by a parent', () => {
    const { rerender } = render(<ResourceLimitsFields inputs={EMPTY} onChange={vi.fn()} errors={{}} />);
    rerender(<ResourceLimitsFields inputs={{ ...EMPTY, enforce: 'warn' }} onChange={vi.fn()} errors={{}} />);
    expect(screen.getByText(ENFORCE_EXPLANATIONS.warn)).toBeInTheDocument();
  });
});

describe('ResourceLimitsFields changes', () => {
  it('reports a typed value together with every other input untouched', () => {
    const inputs: ResourceLimitInputs = { enforce: 'warn', hardFactor: '4', softFactor: '', sustainSeconds: '60', maxCpuPct: '', maxRamMb: '' };
    const onChange = show(inputs);

    fireEvent.change(screen.getByLabelText(/^Max RAM/), { target: { value: '512' } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ ...inputs, maxRamMb: '512' });
  });

  it('reports an emptied field as an empty string, not as 0', () => {
    const onChange = show({ ...EMPTY, hardFactor: '5' });

    fireEvent.change(screen.getByLabelText(/^Hard factor/), { target: { value: '' } });

    expect(onChange).toHaveBeenCalledWith({ ...EMPTY, hardFactor: '' });
  });

  it('reports the chosen enforcement with the numbers kept', () => {
    const inputs = { ...EMPTY, hardFactor: '4' };
    const onChange = show(inputs);

    fireEvent.change(screen.getByLabelText(/^Enforcement/), { target: { value: 'off' } });

    expect(onChange).toHaveBeenCalledWith({ ...inputs, enforce: 'off' });
  });

  it('shows the daemon defaults as placeholders of the factors and the sustain time only', () => {
    show();
    expect(screen.getByLabelText(/^Hard factor/)).toHaveAttribute('placeholder', '3');
    expect(screen.getByLabelText(/^Soft factor/)).toHaveAttribute('placeholder', '1.5');
    expect(screen.getByLabelText(/^Sustain time/)).toHaveAttribute('placeholder', '30');
    expect(screen.getByLabelText(/^Max CPU/)).not.toHaveAttribute('placeholder');
    expect(screen.getByLabelText(/^Max RAM/)).not.toHaveAttribute('placeholder');
  });

  it('accepts decimals: the inputs have step="any"', () => {
    show();
    for (const [, label] of FIELDS) {
      expect(screen.getByLabelText(label)).toHaveAttribute('step', 'any');
    }
  });
});
