import type { ResourceEnforce, ResourceLimits } from './types.js';

/** The daemon's defaults for a job's resource limits; shown as placeholders so an empty field says what applies. */
export const RESOURCE_DEFAULTS = {
  enforce: 'kill',
  hardFactor: 3,
  softFactor: 1.5,
  sustainSeconds: 30,
} as const satisfies Required<Pick<ResourceLimits, 'enforce' | 'hardFactor' | 'softFactor' | 'sustainSeconds'>>;

export const ENFORCE_LABELS: Record<ResourceEnforce, string> = {
  kill: 'Kill',
  warn: 'Warn only',
  off: 'Off',
};

/** One line per mode, shown under the select: what the monitor does to a run that stays over budget. */
export const ENFORCE_EXPLANATIONS: Record<ResourceEnforce, string> = {
  kill: 'The monitor ends a run that stays over its hard limit.',
  warn: 'The monitor reports a run over its hard limit but never ends it.',
  off: 'No limit is checked for this job; runs are still measured.',
};

const ENFORCE_SUMMARIES: Record<ResourceEnforce, string> = {
  kill: 'the monitor ends a run over its hard limit',
  warn: 'the monitor never ends a run',
  off: 'no limit is checked',
};

/** Numeric fields of the form, as the user typed them: absent when the box is empty. */
export type ResourceLimitFields = Partial<Omit<ResourceLimits, 'enforce'>>;
export type ResourceLimitErrors = Partial<Record<keyof ResourceLimitFields, string>>;

const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Mirrors the daemon's validation (hardFactor > 1 and <= 100; softFactor > 1 and below the hard factor, which is
 * the default 3 when not given; sustainSeconds an integer 2..3600; maxCpuPct and maxRamMb > 0), so the field that is
 * wrong is named before the request. The daemon stays the authority: its refusal is shown as well.
 */
export function validateResourceLimitFields(fields: ResourceLimitFields): ResourceLimitErrors {
  const errors: ResourceLimitErrors = {};
  const { hardFactor, softFactor, sustainSeconds, maxCpuPct, maxRamMb } = fields;
  if (hardFactor !== undefined && !(isNumber(hardFactor) && hardFactor > 1 && hardFactor <= 100)) {
    errors.hardFactor = 'The hard factor must be a number greater than 1 and at most 100.';
  }
  if (softFactor !== undefined && !(isNumber(softFactor) && softFactor > 1)) {
    errors.softFactor = 'The soft factor must be a number greater than 1.';
  }
  // The daemon compares the two with the default of whichever is missing, so a hard factor of 1.2 alone is
  // refused (the default soft factor is 1.5). Said on the field the user typed.
  if (errors.hardFactor === undefined && errors.softFactor === undefined) {
    const hard = hardFactor ?? RESOURCE_DEFAULTS.hardFactor;
    const soft = softFactor ?? RESOURCE_DEFAULTS.softFactor;
    if (soft >= hard) {
      if (softFactor !== undefined) {
        errors.softFactor = `The soft factor must be below the hard factor (${hard}${hardFactor === undefined ? ', the default' : ''}). Lower it, or raise the hard factor.`;
      } else {
        errors.hardFactor = `The hard factor must be above the soft factor (${soft}, the default). Raise it, or set a lower soft factor too.`;
      }
    }
  }
  if (sustainSeconds !== undefined && !(isNumber(sustainSeconds) && Number.isInteger(sustainSeconds) && sustainSeconds >= 2 && sustainSeconds <= 3600)) {
    errors.sustainSeconds = 'The sustain time must be a whole number of seconds from 2 to 3600.';
  }
  if (maxCpuPct !== undefined && !(isNumber(maxCpuPct) && maxCpuPct > 0)) {
    errors.maxCpuPct = 'The max CPU must be a number greater than 0 (a percentage of one core).';
  }
  if (maxRamMb !== undefined && !(isNumber(maxRamMb) && maxRamMb > 0)) {
    errors.maxRamMb = 'The max RAM must be a number greater than 0 (megabytes).';
  }
  return errors;
}

/** Whether the limits differ from the defaults, i.e. whether a card or page should say anything about them. */
export function hasCustomLimits(limits: ResourceLimits | undefined): boolean {
  if (limits === undefined) {
    return false;
  }
  return (limits.enforce !== undefined && limits.enforce !== RESOURCE_DEFAULTS.enforce)
    || limits.hardFactor !== undefined || limits.softFactor !== undefined || limits.sustainSeconds !== undefined
    || limits.maxCpuPct !== undefined || limits.maxRamMb !== undefined;
}

/** The short badge text; only meaningful when hasCustomLimits is true. */
export function limitsBadgeLabel(limits: ResourceLimits): string {
  const enforce = limits.enforce ?? RESOURCE_DEFAULTS.enforce;
  if (enforce === 'warn') {
    return 'Resource limits: warn only';
  }
  if (enforce === 'off') {
    return 'Resource limits: off';
  }
  return 'Resource limits: custom';
}

/** The effective values, one line each, for a tooltip or the job page. Absolute ceilings only when set. */
export function describeResourceLimits(limits: ResourceLimits): string[] {
  const enforce = limits.enforce ?? RESOURCE_DEFAULTS.enforce;
  const lines = [
    `Enforcement: ${ENFORCE_LABELS[enforce].toLowerCase()} (${ENFORCE_SUMMARIES[enforce]})`,
    `Hard factor: ${limits.hardFactor ?? RESOURCE_DEFAULTS.hardFactor}`,
    `Soft factor: ${limits.softFactor ?? RESOURCE_DEFAULTS.softFactor}`,
    `Sustained for: ${limits.sustainSeconds ?? RESOURCE_DEFAULTS.sustainSeconds} s`,
  ];
  if (limits.maxCpuPct !== undefined) {
    lines.push(`Max CPU: ${limits.maxCpuPct}%`);
  }
  if (limits.maxRamMb !== undefined) {
    lines.push(`Max RAM: ${limits.maxRamMb} MB`);
  }
  return lines;
}

/** The form's state for the section: what the user typed, so an emptied box stays empty rather than becoming 0. */
export interface ResourceLimitInputs {
  enforce: ResourceEnforce;
  hardFactor: string;
  softFactor: string;
  sustainSeconds: string;
  maxCpuPct: string;
  maxRamMb: string;
}

export function inputsFromLimits(limits: ResourceLimits | undefined): ResourceLimitInputs {
  const text = (n: number | undefined): string => (n === undefined ? '' : String(n));
  return {
    enforce: limits?.enforce ?? RESOURCE_DEFAULTS.enforce,
    hardFactor: text(limits?.hardFactor),
    softFactor: text(limits?.softFactor),
    sustainSeconds: text(limits?.sustainSeconds),
    maxCpuPct: text(limits?.maxCpuPct),
    maxRamMb: text(limits?.maxRamMb),
  };
}

/**
 * What the section sends: only the boxes with something in them, and the enforcement only when it is not the
 * default. An empty result means "no limits of my own", which on an edit clears the stored object. A box holding
 * text that is not a number becomes NaN, which validateResourceLimitFields refuses by name.
 */
export function limitsFromInputs(inputs: ResourceLimitInputs): ResourceLimits {
  const limits: ResourceLimits = {};
  if (inputs.enforce !== RESOURCE_DEFAULTS.enforce) {
    limits.enforce = inputs.enforce;
  }
  for (const key of ['hardFactor', 'softFactor', 'sustainSeconds', 'maxCpuPct', 'maxRamMb'] as const) {
    if (inputs[key].trim() !== '') {
      limits[key] = Number(inputs[key]);
    }
  }
  return limits;
}
