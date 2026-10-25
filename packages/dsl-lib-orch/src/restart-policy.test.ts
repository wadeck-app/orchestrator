import { describe, it, expect } from 'vitest';
import {
  RESTART_DEFAULTS, inputsFromRestart, restartFromInputs, restartOptionsError, retryConflictMessage, validateRestartInputs,
} from './restart-policy.js';

describe('inputsFromRestart', () => {
  it('reads absent, false and true as nothing configured', () => {
    for (const setting of [undefined, false, true] as const) {
      const state = inputsFromRestart(setting);
      expect(state.inputs.maxRestarts).toBe('');
      expect(state.inputs.strategy).toBe(RESTART_DEFAULTS.strategy);
      expect(state.strategyExplicit).toBe(false);
    }
    expect(inputsFromRestart(true).enabled).toBe(true);
    expect(inputsFromRestart(false).enabled).toBe(false);
    expect(inputsFromRestart(undefined).enabled).toBe(false);
  });

  it('reads an object into text, remembering an explicit strategy', () => {
    const state = inputsFromRestart({ strategy: 'exponential', factor: 3, windowSeconds: 60 });
    expect(state).toMatchObject({ enabled: true, strategyExplicit: true, inputs: { strategy: 'exponential', factor: '3', windowSeconds: '60', maxRestarts: '' } });
  });
});

describe('restartFromInputs', () => {
  const empty = inputsFromRestart(true).inputs;

  it('is true when nothing is filled in', () => {
    expect(restartFromInputs(empty, false)).toBe(true);
  });

  it('leaves out what the strategy does not read, and the default strategy', () => {
    expect(restartFromInputs({ ...empty, factor: '3', stepSeconds: '2', maxRestarts: '4' }, false)).toEqual({ factor: 3, maxRestarts: 4 });
    expect(restartFromInputs({ ...empty, strategy: 'fixed', factor: '3', maxDelaySeconds: '9' }, false)).toEqual({ strategy: 'fixed' });
  });

  it('keeps an explicit default strategy', () => {
    expect(restartFromInputs(empty, true)).toEqual({ strategy: 'exponential' });
  });

  it('turns text that is not a number into NaN, which the validation refuses by name', () => {
    expect(restartFromInputs({ ...empty, maxRestarts: 'abc' }, false)).toEqual({ maxRestarts: Number.NaN });
  });
});

describe('restartOptionsError / validateRestartInputs', () => {
  const empty = inputsFromRestart(true).inputs;

  it('accepts the defaults', () => {
    expect(validateRestartInputs(empty, false)).toEqual({});
  });

  it('points at the field with the daemon sentence', () => {
    const errors = validateRestartInputs({ ...empty, windowSeconds: '0' }, false);
    expect(Object.keys(errors)).toEqual(['windowSeconds']);
    expect(errors.windowSeconds).toBe('restartOnExit.windowSeconds must be a whole number of at least 1 (got: 0)');
  });

  it('flags a non-number', () => {
    expect(validateRestartInputs({ ...empty, factor: 'abc' }, false).factor).toContain('restartOnExit.factor must be a number above 1 (got: NaN)');
  });

  it('exposes the field of an object problem', () => {
    expect(restartOptionsError({ initialDelaySeconds: 40 })).toEqual({
      field: 'initialDelaySeconds',
      message: expect.stringContaining('(40) is above restartOnExit.maxDelaySeconds (30, the default)'),
    });
    expect(restartOptionsError({ maxRestarts: 3 })).toBeNull();
  });
});

describe('retryConflictMessage', () => {
  it('is null without a non-empty retry list', () => {
    expect(retryConflictMessage({ id: 'a' })).toBeNull();
    expect(retryConflictMessage({ id: 'a', retryOnExitCodes: [], retryDelays: [] })).toBeNull();
  });

  it('names the job and the command that clears the list', () => {
    expect(retryConflictMessage({ id: 'a', retryDelays: [5] })).toContain('orch edit a --unset retryOnExitCodes,retryDelays');
  });
});
