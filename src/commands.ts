'use strict';

import type { OrchestratorCommands, Job, RuntimeEntry } from './types.js';
import type { Registry } from './registry.js';
import type { State }    from './state.js';
import type { Scheduler } from './scheduler.js';

/**
 * Builds the OrchestratorCommands map for use with createDaemon() and createTestDaemon().
 * Centralised here so index.ts and tests use the exact same command definitions.
 */
export function makeCommands(
  registry: Registry,
  state:    State,
  scheduler: Scheduler,
): OrchestratorCommands {
  return {
    'list-jobs':   () => registry.list(),

    'get-job':     (p) => registry.get((p as { id: string }).id),

    'add-job':     (p) => {
      registry.add(p as Partial<Job>);
      return registry.get((p as { id: string }).id)!;
    },

    'remove-job':  (p) => registry.remove((p as { id: string }).id),

    'enable-job':  (p) => registry.enable((p as { id: string }).id),

    'disable-job': (p) => registry.disable((p as { id: string }).id),

    'edit-job':    (p) => {
      const { id, updates } = p as { id: string; updates: Partial<Job> };
      registry.edit(id, updates);
      return registry.get(id)!;
    },

    'trigger-job': (p) => {
      const { id } = p as { id: string };
      return scheduler.trigger(id);
    },

    'list-state': () => state.getAll() as Record<string, RuntimeEntry>,

    // quit and restart are handled by the SDK's shutdown mechanism;
    // these stubs exist so TypeScript knows they are valid command names.
    'quit':    () => {},
    'restart': () => {},
  };
}
