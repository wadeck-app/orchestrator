'use strict';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorCommands, Job, RuntimeEntry } from './types.js';
import type { Registry } from './registry.js';
import type { State }    from './state.js';
import type { Scheduler } from './scheduler.js';
import type { TrayManager } from './tray-manager.js';

/**
 * Builds the OrchestratorCommands map for use with createDaemon() and createTestDaemon().
 * Centralised here so index.ts and tests use the exact same command definitions.
 */
export function makeCommands(
  registry: Registry,
  state:    State,
  scheduler: Scheduler,
  configDir: string,
  trayManager?: TrayManager,
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
      const { id, ip, userAgent } = p as { id: string; ip?: string; userAgent?: string };
      return scheduler.trigger(id, { kind: 'manual', ip, userAgent });
    },

    'list-state': () => state.getAll(),

    'list-failures': () => state.getUnacknowledgedFailures(),

    'ack-failures': () => { state.acknowledgeAll(); return {}; },

    // quit is handled by the SDK's /quit route; stub so TypeScript accepts it.
    'quit': () => {},

    // restart: gracefully kill the tray (sends {type:exit} via stdin) THEN exit so the
    // Go launcher re-spawns the daemon. Using trayManager.triggerRestart() ensures the same
    // clean kill path as the tray "Restart" button, preventing orphan tray processes.
    // NOTE: config.restart is written by the index.ts 'restart' event handler AFTER tray is
    // killed — do NOT write it here, or the Go launcher would spawn a second daemon before
    // this one exits, causing multiple daemon/tray instances.
    'restart': () => {
      if (trayManager) {
        void trayManager.triggerRestart();
        // triggerRestart() kills the tray then emits 'restart' → index.ts writes config.restart + process.exit(0)
      } else {
        try { writeFileSync(join(configDir, 'config.restart'), '1'); } catch { /* ignore */ }
        process.exit(0);
      }
    },
  };
}
