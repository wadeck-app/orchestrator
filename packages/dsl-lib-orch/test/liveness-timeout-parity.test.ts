import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  LIVENESS_TIMEOUT_DEFAULT_SECONDS, LIVENESS_TIMEOUT_MAX_SECONDS, LIVENESS_TIMEOUT_MIN_SECONDS, livenessTimeoutError,
} from '../src/liveness-timeout.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(here, '../../orchestrator-cli/src');

/*
 * The form checks the liveness command timeout before the request with its own copy of the daemon's rule (it cannot import
 * the CLI). Same bounds, same default, same words up to the value: if the daemon changes one and this copy does not, the
 * form would accept what the daemon refuses, or refuse what it accepts. Change both together.
 */
interface CliTypes {
  LIVENESS_COMMAND_TIMEOUT_SECONDS: number;
  LIVENESS_TIMEOUT_MIN_SECONDS: number;
  LIVENESS_TIMEOUT_MAX_SECONDS: number;
}
interface CliRegistry {
  validateJob: (job: Record<string, unknown>) => void;
}

function daemonRefusal(registry: CliRegistry, value: unknown): string | null {
  try {
    registry.validateJob({
      id: 'j', type: 'cron', schedule: '0 9 * * *', command: 'x',
      liveness: { strategy: 'command', command: 'check', timeoutSeconds: value },
    });
    return null;
  } catch (e) {
    return String(e).replace(/^Error: /, '');
  }
}

describe('the form copy of the liveness timeout rule', () => {
  it('has the daemon\'s bounds and default', async () => {
    const types = await import(pathToFileURL(path.join(CLI_SRC, 'types.ts')).href) as CliTypes;
    expect(LIVENESS_TIMEOUT_MIN_SECONDS).toBe(types.LIVENESS_TIMEOUT_MIN_SECONDS);
    expect(LIVENESS_TIMEOUT_MAX_SECONDS).toBe(types.LIVENESS_TIMEOUT_MAX_SECONDS);
    expect(LIVENESS_TIMEOUT_DEFAULT_SECONDS).toBe(types.LIVENESS_COMMAND_TIMEOUT_SECONDS);
  });

  it.each([1, 30, 3600, 0, -1, 1.5, 3601, 100000])('agrees with the daemon on %s', async (value) => {
    const registry = await import(pathToFileURL(path.join(CLI_SRC, 'registry.ts')).href) as CliRegistry;
    const daemon = daemonRefusal(registry, value);
    const form = livenessTimeoutError(String(value));
    expect(form === null).toBe(daemon === null);
    if (daemon !== null && form !== null) {
      // Same sentence up to the value; the daemon then names its flag, the form says how to get the default.
      const shared = `liveness.timeoutSeconds must be a whole number of seconds from ${LIVENESS_TIMEOUT_MIN_SECONDS} to ${LIVENESS_TIMEOUT_MAX_SECONDS}, got ${value}`;
      expect(daemon.startsWith(shared)).toBe(true);
      expect(form.startsWith(shared)).toBe(true);
    }
  });
});
