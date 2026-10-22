import { describe, expect, it } from 'vitest';
import {
  RESOURCE_DEFAULTS, describeResourceLimits, hasCustomLimits, inputsFromLimits, limitsBadgeLabel, limitsFromInputs, validateResourceLimitFields,
} from './resource-limits.js';

describe('validateResourceLimitFields', () => {
  it('accepts nothing at all (every default applies)', () => {
    expect(validateResourceLimitFields({})).toEqual({});
  });

  it('accepts the boundary values', () => {
    expect(validateResourceLimitFields({ hardFactor: 100, softFactor: 1.01, sustainSeconds: 2, maxCpuPct: 0.1, maxRamMb: 1 })).toEqual({});
    expect(validateResourceLimitFields({ sustainSeconds: 3600 })).toEqual({});
  });

  it.each([1, 0.5, 100.5, -3])('refuses hardFactor %s and names the field and the range', (hardFactor) => {
    expect(validateResourceLimitFields({ hardFactor }).hardFactor).toMatch(/hard factor.*greater than 1 and at most 100/i);
  });

  it('refuses a soft factor of 1 or less', () => {
    expect(validateResourceLimitFields({ softFactor: 1 }).softFactor).toMatch(/soft factor.*greater than 1/i);
  });

  it('refuses a soft factor not below the hard factor given', () => {
    expect(validateResourceLimitFields({ softFactor: 4, hardFactor: 4 }).softFactor).toMatch(/below the hard factor \(4\)/);
  });

  it('measures the soft factor against the default hard factor when none is given', () => {
    expect(validateResourceLimitFields({ softFactor: 3 }).softFactor).toMatch(/below the hard factor \(3, the default\)/);
    expect(validateResourceLimitFields({ softFactor: 2.9 })).toEqual({});
  });

  it('refuses a hard factor not above the default soft factor when no soft factor is given (the daemon does)', () => {
    expect(validateResourceLimitFields({ hardFactor: 1.2 }).hardFactor).toMatch(/above the soft factor \(1\.5, the default\)/);
    expect(validateResourceLimitFields({ hardFactor: 1.2, softFactor: 1.1 })).toEqual({});
    expect(validateResourceLimitFields({ hardFactor: 1.6 })).toEqual({});
  });

  it.each([1, 3601, 2.5, 0])('refuses sustainSeconds %s', (sustainSeconds) => {
    expect(validateResourceLimitFields({ sustainSeconds }).sustainSeconds).toMatch(/whole number of seconds from 2 to 3600/i);
  });

  it.each([0, -1])('refuses a non-positive CPU or RAM ceiling (%s)', (v) => {
    expect(validateResourceLimitFields({ maxCpuPct: v }).maxCpuPct).toMatch(/max cpu.*greater than 0/i);
    expect(validateResourceLimitFields({ maxRamMb: v }).maxRamMb).toMatch(/max ram.*greater than 0/i);
  });

  it('refuses a non-finite number', () => {
    expect(validateResourceLimitFields({ hardFactor: Number.NaN }).hardFactor).toBeDefined();
  });
});

describe('hasCustomLimits', () => {
  it('is false when absent, empty or all-default enforcement', () => {
    expect(hasCustomLimits(undefined)).toBe(false);
    expect(hasCustomLimits({})).toBe(false);
    expect(hasCustomLimits({ enforce: 'kill' })).toBe(false);
  });

  it('is true for a non-kill enforcement or any value set', () => {
    expect(hasCustomLimits({ enforce: 'warn' })).toBe(true);
    expect(hasCustomLimits({ enforce: 'off' })).toBe(true);
    expect(hasCustomLimits({ hardFactor: 5 })).toBe(true);
    expect(hasCustomLimits({ maxRamMb: 512 })).toBe(true);
  });
});

describe('limitsBadgeLabel and describeResourceLimits', () => {
  it('names the enforcement when it is not the default', () => {
    expect(limitsBadgeLabel({ enforce: 'warn' })).toBe('Resource limits: warn only');
    expect(limitsBadgeLabel({ enforce: 'off' })).toBe('Resource limits: off');
  });

  it('says custom when only values are set', () => {
    expect(limitsBadgeLabel({ hardFactor: 5 })).toBe('Resource limits: custom');
  });

  it('lists every effective value, defaults filled in, absolute ceilings only when set', () => {
    expect(describeResourceLimits({ enforce: 'warn', hardFactor: 5, maxRamMb: 512 })).toEqual([
      'Enforcement: warn only (the monitor never ends a run)',
      'Hard factor: 5',
      'Soft factor: 1.5',
      'Sustained for: 30 s',
      'Max RAM: 512 MB',
    ]);
  });

  it('has the documented defaults', () => {
    expect(RESOURCE_DEFAULTS).toEqual({ enforce: 'kill', hardFactor: 3, softFactor: 1.5, sustainSeconds: 30 });
  });
});

describe('inputsFromLimits and limitsFromInputs', () => {
  it('round-trips the limits of a job', () => {
    const limits = { enforce: 'warn', hardFactor: 4.5, sustainSeconds: 60, maxRamMb: 512 } as const;
    expect(limitsFromInputs(inputsFromLimits(limits))).toEqual(limits);
  });

  it('gives nothing for no limits, empty boxes or the default enforcement alone', () => {
    expect(limitsFromInputs(inputsFromLimits(undefined))).toEqual({});
    expect(limitsFromInputs(inputsFromLimits({ enforce: 'kill' }))).toEqual({});
  });

  it('turns text that is not a number into NaN, which validation refuses', () => {
    const limits = limitsFromInputs({ ...inputsFromLimits(undefined), hardFactor: 'abc' });
    expect(limits.hardFactor).toBeNaN();
    expect(validateResourceLimitFields(limits).hardFactor).toBeDefined();
  });
});
