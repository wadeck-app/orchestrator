import fs   from 'node:fs';
import path from 'node:path';
import type { HookConfig } from '@wadeck-app/shared-cli/HookDispatcher';
import { ONCE_RETENTION_DEFAULTS } from './registry.js';

export interface DaemonConfig {
  autoUpdate?: boolean;
  /** Seconds to wait after daemon start before firing the first catch-up job (default: 300) */
  catchUpInitialDelaySeconds?: number;
  /** Seconds between consecutive catch-up jobs on startup (default: 300) */
  catchUpStaggerSeconds?: number;
  /** Days a spent `once` job is kept before being pruned (default: 360). 0 keeps none. */
  onceRetentionDays?: number;
  /** How many spent `once` jobs are kept at most (default: 50). 0 keeps none. */
  onceRetentionMaxJobs?: number;
}

const DEFAULTS: Required<DaemonConfig> = {
  autoUpdate:                  true,
  catchUpInitialDelaySeconds:  300,
  catchUpStaggerSeconds:       300,
  // From the registry, so the documented default and the one a Registry built without options uses
  // cannot drift: two places spelling "360" is two places to change and one to forget.
  onceRetentionDays:           ONCE_RETENTION_DEFAULTS.onceRetentionDays,
  onceRetentionMaxJobs:        ONCE_RETENTION_DEFAULTS.onceRetentionMaxJobs,
};

/**
 * What each key accepts. A table rather than a chain of ifs, so the parser can also tell a typo from
 * a key it simply has not been taught -- `onceRetentionDay: 30` used to be indistinguishable from
 * "not configured", which is the worst way for a setting to fail.
 */
const KEY_KINDS: Record<keyof Required<DaemonConfig>, 'boolean' | 'nonNegativeInt'> = {
  autoUpdate:                 'boolean',
  catchUpInitialDelaySeconds: 'nonNegativeInt',
  catchUpStaggerSeconds:      'nonNegativeInt',
  onceRetentionDays:          'nonNegativeInt',
  onceRetentionMaxJobs:       'nonNegativeInt',
};

/**
 * Reads <configDir>/hooks.json into a hooks map for HookDispatcher.
 * Format: { "onJobRetry": [{ "type": "cli", "command": "...", "args": [...] }], ... }
 * Missing file or parse errors silently return empty map.
 */
export function loadOrchestratorHooks(configDir: string): Record<string, HookConfig[]> {
  const file = path.join(configDir, 'hooks.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw) as Record<string, HookConfig[]>;
  } catch { return {}; }
}

/**
 * Reads <configDir>/config.yml into a DaemonConfig object.
 *
 * Only handles simple "key: value" lines -- no nested YAML. A missing file is normal and says nothing;
 * anything the parser cannot use is reported through `onWarn` and falls back to the default.
 *
 * The reporting is the point. This used to swallow everything: `catchUpStaggerSeconds: fve` became
 * NaN, went straight into a setTimeout, and every catch-up job fired at once with the user believing
 * their 300-second stagger was in force. A silently misread config file is worse than a missing one,
 * because there is nothing to notice. `onWarn` is optional so callers that have nowhere to log -- the
 * tests, the self-check -- are not forced to invent a sink.
 */
export function loadDaemonConfig(
  configDir: string,
  onWarn: (message: string) => void = () => {},
): Required<DaemonConfig> {
  const file = path.join(configDir, 'config.yml');
  const result: DaemonConfig = {};

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // Absent or unreadable: every default applies, and that is the normal case rather than a fault.
    return { ...DEFAULTS };
  }

  for (const [lineNo, line] of raw.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const where = `config.yml line ${lineNo + 1}`;

    const colon = trimmed.indexOf(':');
    if (colon < 0) {
      onWarn(`${where}: ignored, no "key: value" -- found ${JSON.stringify(trimmed)}`);
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    // A trailing `# ...` is a YAML comment, not part of the value. Without this, a perfectly ordinary
    // `onceRetentionDays: 30  # a month` parsed to NaN.
    const val = trimmed.slice(colon + 1).replace(/\s+#.*$/, '').trim();

    const kind = KEY_KINDS[key as keyof Required<DaemonConfig>];
    if (kind === undefined) {
      onWarn(
        `${where}: unknown key ${JSON.stringify(key)}, ignored. `
        + `Known keys: ${Object.keys(KEY_KINDS).join(', ')}`,
      );
      continue;
    }

    if (kind === 'boolean') {
      if (val !== 'true' && val !== 'false') {
        onWarn(`${where}: ${key} must be true or false, found ${JSON.stringify(val)} -- using ${DEFAULTS[key as 'autoUpdate']}`);
        continue;
      }
      result.autoUpdate = val === 'true';
      continue;
    }

    const num = Number(val);
    // Integer and non-negative, both checked: a fraction of a day and a negative retention are each a
    // setting the rest of the code cannot honour, and accepting them would push the failure downstream
    // where it has no name attached.
    if (val === '' || !Number.isInteger(num) || num < 0) {
      const fallback = DEFAULTS[key as 'catchUpStaggerSeconds'];
      onWarn(`${where}: ${key} must be a non-negative whole number, found ${JSON.stringify(val)} -- using ${fallback}`);
      continue;
    }
    result[key as 'catchUpStaggerSeconds'] = num;
  }

  return { ...DEFAULTS, ...result };
}
