'use strict';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorCommands, Job, RuntimeEntry } from './types.js';
import type { Registry } from './registry.js';
import type { State }    from './state.js';
import type { Scheduler } from './scheduler.js';
import type { TrayManager } from './tray-manager.js';
import type { AuditLogger } from './audit.js';
import type { EventPublisher } from './event-publisher.js';
import { getNextFirings } from './cronNext.js';
import { WebhookManager, type WebhookConfig } from './webhook-manager.js';
import { SecretsManager } from './secrets.js';


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
  audit?: AuditLogger,
  events?: EventPublisher,
): OrchestratorCommands {
  const secrets = new SecretsManager(configDir);
  return {
    'list-jobs':   () => registry.list(),

    'get-job':     (p) => registry.get((p as { id: string }).id),

    'add-job':     (p) => {
      const job = registry.add(p as Partial<Job>);
      audit?.log('job.added', { jobId: (p as { id: string }).id, label: (p as { label?: string }).label });
      return registry.get((p as { id: string }).id)!;
    },

    'remove-job':  (p) => {
      const id = (p as { id: string }).id;
      const job = registry.get(id);
      registry.remove(id);
      audit?.log('job.deleted', { jobId: id, label: job?.label });
    },

    'enable-job':  (p) => {
      const id = (p as { id: string }).id;
      registry.enable(id);
      audit?.log('job.enabled', { jobId: id });
    },

    'disable-job': (p) => {
      const id = (p as { id: string }).id;
      registry.disable(id);
      audit?.log('job.disabled', { jobId: id });
    },

    'edit-job':    (p) => {
      const { id, updates } = p as { id: string; updates: Partial<Job> };
      registry.edit(id, updates);
      audit?.log('job.edited', { jobId: id });
      return registry.get(id)!;
    },

    'trigger-job': (p) => {
      const { id, ip, userAgent } = p as { id: string; ip?: string; userAgent?: string };
      const job = registry.get(id);
      audit?.log('job.triggered_manual', { jobId: id, label: job?.label, ip, userAgent });
      events?.publish('job.triggered_manual', { jobId: id, label: job?.label ?? id, ip: ip ?? null, userAgent: userAgent ?? null });
      return scheduler.trigger(id, { kind: 'manual', ip, userAgent });
    },

    'list-state': () => state.getAll(),

    'list-failures': () => state.getUnacknowledgedFailures(),

    'ack-failures': () => { state.acknowledgeAll(); return {}; },

    'list-audit': (p) => {
      const limit = ((p as { limit?: number })?.limit) ?? 50;
      return audit?.readLast(limit) ?? [];
    },

    'get-uptime': () => {
      const result: Record<string, number | null> = {};
      for (const job of registry.list()) {
        result[job.id] = state.getUptimePercent(job.id);
      }
      return result;
    },

    'get-resource-baseline': (p) => {
      const { jobId } = p as { jobId: string };
      return state.getResourceBaseline(jobId) ?? null;
    },

    'get-schedule': () => {
      return registry.list()
        .filter(j => j.type === 'cron' && j.enabled && j.schedule)
        .map(j => ({
          jobId: j.id,
          label: j.label,
          next: getNextFirings(j.schedule!, 5).map(d => d.toISOString()),
        }));
    },

    'dry-run-job': (p) => {
      const { id } = p as { id: string };
      return scheduler.dryRun(id);
    },

    'list-secrets': () => secrets.list(),
    'set-secret':   (p) => {
      const { name, value } = p as { name: string; value: string };
      secrets.set(name, value);
    },
    'delete-secret': (p) => {
      const { name } = p as { name: string };
      secrets.delete(name);
    },

    'list-webhooks': () => {
      const wm = new WebhookManager(configDir);
      return wm.load();
    },
    'add-webhook': (p) => {
      const wm = new WebhookManager(configDir);
      wm.add(p as WebhookConfig);
    },
    'remove-webhook': (p) => {
      const wm = new WebhookManager(configDir);
      wm.remove((p as { id: string }).id);
    },
    'toggle-webhook': (p) => {
      const wm = new WebhookManager(configDir);
      return wm.toggle((p as { id: string }).id);
    },

    // quit is handled by the SDK's /quit route; stub so TypeScript accepts it.
    'quit': () => {},

    // restart: gracefully kill the tray (sends {type:exit} via stdin) THEN exit so the
    // Go launcher re-spawns the daemon. Using trayManager.triggerRestart() ensures the same
    // clean kill path as the tray "Restart" button, preventing orphan tray processes.
    // NOTE: config.restart is written by the index.ts 'restart' event handler AFTER tray is
    // killed - do NOT write it here, or the Go launcher would spawn a second daemon before
    // this one exits, causing multiple daemon/tray instances.
    'restart': () => {
      audit?.log('daemon.restart');
      events?.publish('daemon.restarted', { pid: process.pid });
      if (trayManager) {
        void trayManager.triggerRestart();
        // triggerRestart() kills the tray then emits 'restart' -> index.ts writes config.restart + process.exit(0)
      } else {
        try { writeFileSync(join(configDir, 'config.restart'), '1'); } catch { /* ignore */ }
        process.exit(0);
      }
    },
  };
}
