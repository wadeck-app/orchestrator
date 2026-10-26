import type { RestartOnExit } from './types.js';

/*
 * The restart policy (`restartOnExit`) as the job form edits it. The daemon's own rules live in
 * orchestrator-cli/src/restart-policy.ts, which this package cannot import: test/restart-policy-parity.test.ts
 * compares the defaults and every refusal sentence of the two, so change both together.
 */

export type RestartStrategy = NonNullable<RestartOnExit['strategy']>;

export const RESTART_STRATEGIES: readonly RestartStrategy[] = ['fixed', 'linear', 'exponential'];

/** The daemon's defaults; shown as placeholders so an empty box says what applies. */
export const RESTART_DEFAULTS = {
  strategy: 'exponential' as RestartStrategy,
  initialDelaySeconds: 1,
  factor: 2,
  maxDelaySeconds: 30,
  maxRestarts: 10,
  windowSeconds: 300,
  stableAfterSeconds: 900,
};

export const RESTART_STRATEGY_LABELS: Record<RestartStrategy, string> = {
  fixed: 'Fixed',
  linear: 'Linear',
  exponential: 'Exponential (default)',
};

/** One line per strategy, shown under the select: how the pause between two restarts grows. */
export const RESTART_STRATEGY_EXPLANATIONS: Record<RestartStrategy, string> = {
  fixed: 'The pause is always the initial delay.',
  linear: 'The pause grows by the step at each restart, up to the max delay.',
  exponential: 'The pause is multiplied by the factor at each restart, up to the max delay.',
};

/** The keys of the object form that carry a number. */
export type RestartNumberKey = Exclude<keyof RestartOnExit, 'strategy'>;

/** The form's state for the policy: what the user typed, so an emptied box stays empty rather than becoming 0. */
export interface RestartInputs {
  strategy: RestartStrategy;
  initialDelaySeconds: string;
  factor: string;
  stepSeconds: string;
  maxDelaySeconds: string;
  maxRestarts: string;
  windowSeconds: string;
  stableAfterSeconds: string;
}

export type RestartFieldErrors = Partial<Record<keyof RestartInputs, string>>;

const NUMBER_KEYS: readonly RestartNumberKey[] = [
  'initialDelaySeconds', 'factor', 'stepSeconds', 'maxDelaySeconds', 'maxRestarts', 'windowSeconds', 'stableAfterSeconds',
];

/** Whether a strategy reads an option; an option it ignores is neither shown nor sent (the daemon refuses it). */
export function strategyUses(strategy: RestartStrategy, key: RestartNumberKey): boolean {
  if (key === 'factor') {
    return strategy === 'exponential';
  }
  if (key === 'stepSeconds') {
    return strategy === 'linear';
  }
  if (key === 'maxDelaySeconds') {
    return strategy !== 'fixed';
  }
  return true;
}

export interface RestartFormState {
  /** The switch: whether the job has a restart policy. */
  enabled: boolean;
  inputs: RestartInputs;
  /** The stored object spelled the strategy out (even the default one): save it the same way instead of rewriting it. */
  strategyExplicit: boolean;
}

export function inputsFromRestart(setting: boolean | RestartOnExit | undefined): RestartFormState {
  const options: RestartOnExit = typeof setting === 'object' && setting !== null ? setting : {};
  const text = (n: number | undefined): string => (n === undefined ? '' : String(n));
  return {
    enabled: setting !== undefined && setting !== false,
    strategyExplicit: options.strategy !== undefined,
    inputs: {
      strategy: options.strategy ?? RESTART_DEFAULTS.strategy,
      initialDelaySeconds: text(options.initialDelaySeconds),
      factor: text(options.factor),
      stepSeconds: text(options.stepSeconds),
      maxDelaySeconds: text(options.maxDelaySeconds),
      maxRestarts: text(options.maxRestarts),
      windowSeconds: text(options.windowSeconds),
      stableAfterSeconds: text(options.stableAfterSeconds),
    },
  };
}

/**
 * What the policy sends: the strategy when it is not the default (or was spelled out already), then only the boxes the
 * strategy reads that have something in them. Nothing filled in is `true`, the defaults. Text that is not a number
 * becomes NaN, which restartOptionsError refuses by name.
 */
export function restartFromInputs(inputs: RestartInputs, strategyExplicit: boolean): true | RestartOnExit {
  const options: RestartOnExit = {};
  if (inputs.strategy !== RESTART_DEFAULTS.strategy || strategyExplicit) {
    options.strategy = inputs.strategy;
  }
  for (const key of NUMBER_KEYS) {
    const text = inputs[key].trim();
    if (text !== '' && strategyUses(inputs.strategy, key)) {
      options[key] = Number(text);
    }
  }
  return Object.keys(options).length === 0 ? true : options;
}

function show(value: unknown): string {
  return typeof value === 'number' ? String(value) : (JSON.stringify(value) ?? String(value));
}

const isPositiveNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isWholeAtLeastOne = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 1;

/**
 * Why `options` is not a valid restartOnExit object, with the key it is about, or null. The sentences are the daemon's
 * own (restartOnExitError), so what the form refuses is what the daemon would have refused.
 */
export function restartOptionsError(options: RestartOnExit): { field: keyof RestartInputs; message: string } | null {
  const problem = (field: keyof RestartInputs, message: string) => ({ field, message });
  const given: Record<string, unknown> = Object.fromEntries(Object.entries(options));

  const strategy = given['strategy'] ?? RESTART_DEFAULTS.strategy;
  if (!(RESTART_STRATEGIES as readonly unknown[]).includes(strategy)) {
    return problem('strategy', `restartOnExit.strategy must be one of ${RESTART_STRATEGIES.join(', ')} (got: ${show(given['strategy'])})`);
  }
  for (const key of ['initialDelaySeconds', 'stepSeconds', 'maxDelaySeconds'] as const) {
    if (given[key] !== undefined && !isPositiveNumber(given[key])) {
      return problem(key, `restartOnExit.${key} must be a number above 0 (got: ${show(given[key])})`);
    }
  }
  if (given['factor'] !== undefined && !(typeof given['factor'] === 'number' && Number.isFinite(given['factor']) && given['factor'] > 1)) {
    return problem('factor', `restartOnExit.factor must be a number above 1 (got: ${show(given['factor'])}); for a delay that never changes use the fixed strategy`);
  }
  for (const key of ['maxRestarts', 'windowSeconds', 'stableAfterSeconds'] as const) {
    if (given[key] !== undefined && !isWholeAtLeastOne(given[key])) {
      return problem(key, `restartOnExit.${key} must be a whole number of at least 1 (got: ${show(given[key])})`);
    }
  }
  if (given['factor'] !== undefined && strategy !== 'exponential') {
    return problem('factor', `restartOnExit.factor only applies to the exponential strategy, and this job uses "${String(strategy)}". Remove factor, or set strategy to exponential`);
  }
  if (given['stepSeconds'] !== undefined && strategy !== 'linear') {
    return problem('stepSeconds', `restartOnExit.stepSeconds only applies to the linear strategy, and this job uses "${String(strategy)}". Remove stepSeconds, or set strategy to linear`);
  }
  if (given['maxDelaySeconds'] !== undefined && strategy === 'fixed') {
    return problem('maxDelaySeconds', 'restartOnExit.maxDelaySeconds does not apply to the fixed strategy (the delay never changes). Remove maxDelaySeconds, or use the linear or exponential strategy');
  }
  if (strategy !== 'fixed') {
    const initial = (given['initialDelaySeconds'] ?? RESTART_DEFAULTS.initialDelaySeconds) as number;
    const explicit = given['maxDelaySeconds'] !== undefined;
    const max = (given['maxDelaySeconds'] ?? RESTART_DEFAULTS.maxDelaySeconds) as number;
    if (initial > max) {
      // The ceiling is the box to raise when the user gave one, and the initial delay when the ceiling is only the default.
      return problem(
        explicit ? 'maxDelaySeconds' : 'initialDelaySeconds',
        `restartOnExit.initialDelaySeconds (${initial}) is above restartOnExit.maxDelaySeconds (${max}${explicit ? '' : ', the default'}). Raise maxDelaySeconds, or use the fixed strategy for a constant delay`,
      );
    }
  }
  return null;
}

/** The per-field refusals of what is typed in the boxes: at most one, the first the daemon would report. */
export function validateRestartInputs(inputs: RestartInputs, strategyExplicit: boolean): RestartFieldErrors {
  const options = restartFromInputs(inputs, strategyExplicit);
  const problem = options === true ? null : restartOptionsError(options);
  return problem === null ? {} : { [problem.field]: problem.message };
}

/** 90 -> "90 s", 300 -> "5 min", 7200 -> "2 h": the largest unit that divides the value exactly. */
function duration(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) {
    return `${seconds / 3600} h`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} min`;
  }
  return `${seconds} s`;
}

/** The stored policy in plain words, defaults filled in; null when the job has none. */
export function describeRestartOnExit(setting: boolean | RestartOnExit | undefined): string | null {
  if (setting === undefined || setting === false) {
    return null;
  }
  const options: RestartOnExit = setting === true ? {} : setting;
  const strategy = options.strategy ?? RESTART_DEFAULTS.strategy;
  const initial = options.initialDelaySeconds ?? RESTART_DEFAULTS.initialDelaySeconds;
  const max = options.maxDelaySeconds ?? RESTART_DEFAULTS.maxDelaySeconds;
  let pause: string;
  if (strategy === 'fixed') {
    pause = `fixed ${duration(initial)}`;
  } else if (strategy === 'linear') {
    pause = `linear from ${duration(initial)} (+${duration(options.stepSeconds ?? initial)}) up to ${duration(max)}`;
  } else {
    pause = `exponential from ${duration(initial)} (x${options.factor ?? RESTART_DEFAULTS.factor}) up to ${duration(max)}`;
  }
  const limit = `at most ${options.maxRestarts ?? RESTART_DEFAULTS.maxRestarts} per ${duration(options.windowSeconds ?? RESTART_DEFAULTS.windowSeconds)}`;
  const stable = options.stableAfterSeconds === undefined ? '' : `; a run that stays up ${duration(options.stableAfterSeconds)} resets the count`;
  return `Restarts after any exit, ${pause}, ${limit}${stable}`;
}

/**
 * Why a job cannot have a restart policy and a retry list at once, or null. The daemon's restartConflictError says the
 * same; the form does not edit the retry list, so the way out it can name is the CLI command that clears it.
 */
export function retryConflictMessage(job: { id?: string; retryOnExitCodes?: unknown; retryDelays?: unknown }): string | null {
  const retries = (Array.isArray(job.retryOnExitCodes) && job.retryOnExitCodes.length > 0)
    || (Array.isArray(job.retryDelays) && job.retryDelays.length > 0);
  if (!retries) {
    return null;
  }
  return 'restartOnExit and retryOnExitCodes/retryDelays cannot be used on the same job: restartOnExit already restarts the job '
    + 'after every exit, so a retry list would never be reached. '
    + `To restart after any exit, clear the retry list first (this form does not edit it): orch edit ${job.id ?? '<id>'} --unset retryOnExitCodes,retryDelays`;
}
