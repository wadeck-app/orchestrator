import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RestartOnExit } from '../src/types.js';
import { RESTART_DEFAULTS, RESTART_STRATEGIES, restartOptionsError } from '../src/restart-policy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_POLICY = path.resolve(here, '../../orchestrator-cli/src/restart-policy.ts');

/*
 * The form validates restartOnExit before the request with its own copy of the daemon's rules (it cannot import the
 * CLI). Same sentences, same defaults: if the daemon changes a rule or a default and this copy does not, the form
 * would show a placeholder or a refusal that is no longer true. Change both together.
 */
interface CliPolicy {
  RESTART_DEFAULTS: Record<string, unknown>;
  RESTART_STRATEGIES: readonly string[];
  restartOnExitError: (value: unknown) => string | null;
}

const CASES: Array<[string, Record<string, unknown>]> = [
  ['strategy only', { strategy: 'fixed' }],
  ['unknown strategy', { strategy: 'quadratic' }],
  ['initial delay 0', { initialDelaySeconds: 0 }],
  ['initial delay NaN', { initialDelaySeconds: Number.NaN }],
  ['initial delay above the default ceiling', { initialDelaySeconds: 45 }],
  ['initial delay above an explicit ceiling', { initialDelaySeconds: 10, maxDelaySeconds: 5 }],
  ['initial delay above the ceiling, but fixed', { strategy: 'fixed', initialDelaySeconds: 45 }],
  ['factor 1', { factor: 1 }],
  ['factor 1.5', { factor: 1.5 }],
  ['factor on fixed', { strategy: 'fixed', factor: 3 }],
  ['factor on linear', { strategy: 'linear', factor: 3 }],
  ['step 0', { strategy: 'linear', stepSeconds: 0 }],
  ['step on exponential', { stepSeconds: 2 }],
  ['max delay 0', { maxDelaySeconds: 0 }],
  ['max delay on fixed', { strategy: 'fixed', maxDelaySeconds: 9 }],
  ['max restarts 0', { maxRestarts: 0 }],
  ['max restarts 2.5', { maxRestarts: 2.5 }],
  ['max restarts NaN', { maxRestarts: Number.NaN }],
  ['window 0', { windowSeconds: 0 }],
  ['window 1.5', { windowSeconds: 1.5 }],
  ['stable after -1', { stableAfterSeconds: -1 }],
  ['everything valid', { strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 20, maxRestarts: 4, windowSeconds: 120, stableAfterSeconds: 600 }],
];

describe('restart policy: dsl-lib-orch vs orchestrator-cli', async () => {
  const cli = await import(/* @vite-ignore */ pathToFileURL(CLI_POLICY).href) as CliPolicy;

  it('has the same defaults and strategies', () => {
    expect(RESTART_DEFAULTS).toEqual(cli.RESTART_DEFAULTS);
    expect([...RESTART_STRATEGIES]).toEqual([...cli.RESTART_STRATEGIES]);
  });

  it.each(CASES)('says the same about: %s', (_name, options) => {
    expect(restartOptionsError(options as RestartOnExit)?.message ?? null).toBe(cli.restartOnExitError(options));
  });
});
