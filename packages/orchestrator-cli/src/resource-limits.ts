import { RESOURCE_ENFORCE_MODES, type ResourceEnforce, type ResourceLimits } from './types.js';

/** What a job gets for every key it does not set. More tolerant than the fixed 1.2x / 2x / 3 samples it replaces. */
export const RESOURCE_LIMIT_DEFAULTS = {
  enforce:        'kill' as ResourceEnforce,
  hardFactor:     3,
  softFactor:     1.5,
  sustainSeconds: 30,
};

export const HARD_FACTOR_MAX = 100;
export const SUSTAIN_SECONDS_MIN = 2;
export const SUSTAIN_SECONDS_MAX = 3600;

export const RESOURCE_LIMIT_KEYS = ['enforce', 'hardFactor', 'softFactor', 'sustainSeconds', 'maxCpuPct', 'maxRamMb'] as const;

const show = (v: unknown): string => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : JSON.stringify(v) ?? String(v));

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Why `value` cannot be a job's resourceLimits, or null when it can. The sentence names the field, the
 * value received and the range allowed, so the caller knows what to type instead.
 */
export function resourceLimitsError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `Job resourceLimits must be an object such as { "enforce": "warn", "hardFactor": 4 } (got: ${show(value)}). `
      + 'To remove it, clear it: orch edit <id> --unset resourceLimits';
  }
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!(RESOURCE_LIMIT_KEYS as readonly string[]).includes(key)) {
      return `Job resourceLimits.${key} is unknown. Allowed keys: ${RESOURCE_LIMIT_KEYS.join(', ')}.`;
    }
  }
  if (v.enforce !== undefined && !(RESOURCE_ENFORCE_MODES as readonly unknown[]).includes(v.enforce)) {
    return `Job resourceLimits.enforce must be one of ${RESOURCE_ENFORCE_MODES.join(', ')} (got: ${show(v.enforce)}).`;
  }
  if (v.hardFactor !== undefined
    && (!isNumber(v.hardFactor) || v.hardFactor <= 1 || v.hardFactor > HARD_FACTOR_MAX)) {
    return `Job resourceLimits.hardFactor must be a number greater than 1 and at most ${HARD_FACTOR_MAX}, a multiple of the baseline (got: ${show(v.hardFactor)}).`;
  }
  if (v.softFactor !== undefined && (!isNumber(v.softFactor) || v.softFactor <= 1)) {
    return `Job resourceLimits.softFactor must be a number greater than 1 and below hardFactor, a multiple of the baseline (got: ${show(v.softFactor)}).`;
  }
  const hard = (v.hardFactor as number | undefined) ?? RESOURCE_LIMIT_DEFAULTS.hardFactor;
  const soft = (v.softFactor as number | undefined) ?? RESOURCE_LIMIT_DEFAULTS.softFactor;
  if (soft >= hard) {
    const name = (explicit: boolean, key: string): string => `${key}${explicit ? '' : ` (default ${key === 'hardFactor' ? RESOURCE_LIMIT_DEFAULTS.hardFactor : RESOURCE_LIMIT_DEFAULTS.softFactor})`}`;
    const field = v.softFactor !== undefined ? 'softFactor' : 'hardFactor';
    return `Job resourceLimits.${field} is inconsistent: softFactor must be below hardFactor, but ${name(v.softFactor !== undefined, 'softFactor')} is ${soft} and ${name(v.hardFactor !== undefined, 'hardFactor')} is ${hard}. `
      + 'Set both so that softFactor < hardFactor.';
  }
  if (v.sustainSeconds !== undefined) {
    const s = v.sustainSeconds;
    if (!isNumber(s) || !Number.isInteger(s)) {
      return `Job resourceLimits.sustainSeconds must be a whole number of seconds from ${SUSTAIN_SECONDS_MIN} to ${SUSTAIN_SECONDS_MAX} (got: ${show(s)}).`;
    }
    if (s < SUSTAIN_SECONDS_MIN || s > SUSTAIN_SECONDS_MAX) {
      return `Job resourceLimits.sustainSeconds must be from ${SUSTAIN_SECONDS_MIN} to ${SUSTAIN_SECONDS_MAX} seconds (got: ${s}).`;
    }
  }
  if (v.maxCpuPct !== undefined && (!isNumber(v.maxCpuPct) || v.maxCpuPct <= 0)) {
    return `Job resourceLimits.maxCpuPct must be a number greater than 0, a CPU percentage (got: ${show(v.maxCpuPct)}).`;
  }
  if (v.maxRamMb !== undefined && (!isNumber(v.maxRamMb) || v.maxRamMb <= 0)) {
    return `Job resourceLimits.maxRamMb must be a number greater than 0, in megabytes (got: ${show(v.maxRamMb)}).`;
  }
  return null;
}

/** A pair of limits; a side is null when nothing defines it (no baseline and no absolute ceiling for it). */
export interface ResourceThreshold {
  cpuPct: number | null;
  ramMb:  number | null;
}

/** What the monitor holds one run to. */
export interface EffectiveResourceLimits {
  enforce:        ResourceEnforce;
  /** Consecutive samples over the hard budget that make a breach sustained. */
  sustainSamples: number;
  /** Warning budget: factor of the baseline, so null without one. */
  soft: { cpuPct: number; ramMb: number } | null;
  /** Kill budget: an absolute ceiling where set, else a factor of the baseline; null when neither side is defined. */
  hard: ResourceThreshold | null;
}

/**
 * Turns a job's (already validated) limits and its baseline into the numbers the monitor compares against.
 * The factors need the baseline; an absolute ceiling does not, so it holds from the first run.
 */
export function resolveResourceLimits(
  limits: ResourceLimits | undefined,
  baseline: { cpuPct: number; ramMb: number } | null,
  sampleIntervalMs: number,
): EffectiveResourceLimits {
  const enforce        = limits?.enforce        ?? RESOURCE_LIMIT_DEFAULTS.enforce;
  const hardFactor     = limits?.hardFactor     ?? RESOURCE_LIMIT_DEFAULTS.hardFactor;
  const softFactor     = limits?.softFactor     ?? RESOURCE_LIMIT_DEFAULTS.softFactor;
  const sustainSeconds = limits?.sustainSeconds ?? RESOURCE_LIMIT_DEFAULTS.sustainSeconds;

  const hardCpu = limits?.maxCpuPct ?? (baseline ? baseline.cpuPct * hardFactor : null);
  const hardRam = limits?.maxRamMb  ?? (baseline ? baseline.ramMb  * hardFactor : null);
  return {
    enforce,
    sustainSamples: Math.max(1, Math.ceil(sustainSeconds / (sampleIntervalMs / 1000))),
    soft: baseline ? { cpuPct: baseline.cpuPct * softFactor, ramMb: baseline.ramMb * softFactor } : null,
    hard: hardCpu === null && hardRam === null ? null : { cpuPct: hardCpu, ramMb: hardRam },
  };
}
