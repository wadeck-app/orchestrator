import type { JobProgressSetting } from '../types.js';
import { PROGRESS_STRATEGY_IDS, STRATEGIES } from './registry.js';
import type { ProgressStrategy } from './types.js';

export { PROGRESS_STRATEGY_IDS };

/** The pseudo-ids that are modes, not strategies. */
export const PROGRESS_MODES = ['auto', 'off'] as const;

/** Options are stored in registry.json and sent on every list: keep them small. */
export const PROGRESS_OPTIONS_MAX_JSON = 16_384;

export type ResolvedProgressSetting =
  | { kind: 'auto' }
  | { kind: 'off' }
  | { kind: 'strategy'; id: string; options: unknown };

/** Reads a setting already accepted by progressSettingError (or stored by an older daemon, see the engine). */
export function resolveProgressSetting(setting: JobProgressSetting | undefined): ResolvedProgressSetting {
  const id = typeof setting === 'object' && setting !== null ? setting.strategy : setting;
  const options = typeof setting === 'object' && setting !== null ? setting.options : undefined;
  if (id === undefined || id === 'auto') {
    return { kind: 'auto' };
  }
  if (id === 'off') {
    return { kind: 'off' };
  }
  return { kind: 'strategy', id, options };
}

function accepted(ids: readonly string[]): string {
  return [...PROGRESS_MODES, ...ids].join(', ');
}

/**
 * Why `setting` is not a valid `progress` value, or null when it is. Names what is accepted and, for an
 * unknown id, the registered ids. `strategies` is a test seam.
 */
export function progressSettingError(
  setting: unknown,
  strategies: readonly ProgressStrategy[] = STRATEGIES,
): string | null {
  const ids = strategies.map(s => s.id);
  const shapes = `progress must be "auto", "off", a strategy id (${ids.join(', ')}) or { "strategy": "<id>", "options": {...} }`;

  let id: unknown;
  let options: unknown;
  let hasOptions = false;
  if (typeof setting === 'string') {
    id = setting;
  } else if (typeof setting === 'object' && setting !== null && !Array.isArray(setting)) {
    const extra = Object.keys(setting).filter(k => k !== 'strategy' && k !== 'options');
    if (extra.length > 0) {
      return `${shapes} (unexpected key${extra.length > 1 ? 's' : ''}: ${extra.join(', ')})`;
    }
    id = (setting as { strategy?: unknown }).strategy;
    options = (setting as { options?: unknown }).options;
    hasOptions = options !== undefined;
  } else {
    return `${shapes} (got: ${JSON.stringify(setting) ?? String(setting)})`;
  }

  if (typeof id !== 'string' || id === '') {
    return `${shapes} (got: ${JSON.stringify(setting)})`;
  }
  if (id === 'auto' || id === 'off') {
    return hasOptions ? `progress "${id}" takes no options (remove "options", or name a strategy: ${ids.join(', ')})` : null;
  }
  const strategy = strategies.find(s => s.id === id);
  if (!strategy) {
    return `Unknown progress strategy "${id}". Accepted: ${accepted(ids)}`;
  }
  if (hasOptions) {
    const size = JSON.stringify(options)?.length ?? 0;
    if (size > PROGRESS_OPTIONS_MAX_JSON) {
      return `progress options for "${id}" are too large (${size} characters, at most ${PROGRESS_OPTIONS_MAX_JSON})`;
    }
  }
  const checked = strategy.validateOptions(options);
  if (!checked.ok) {
    return `progress options for "${id}" are invalid: ${checked.error}`;
  }
  return null;
}
