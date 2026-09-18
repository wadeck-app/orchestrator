'use strict';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OrchestratorCommands, Job, RuntimeEntry } from './types.js';
import type { Registry } from './registry.js';
import type { State }    from './state.js';
import type { Scheduler } from './scheduler.js';
import type { TrayManager } from './tray-manager.js';
import { TRAY_ACTIONS } from './tray-manager.js';
import type { AuditLogger } from './audit.js';
import type { EventPublisher } from './event-publisher.js';
import type { ExecManager } from './exec-manager.js';
import { getNextFirings } from './cronNext.js';
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
  execManager?: ExecManager,
): OrchestratorCommands {
  const secrets = new SecretsManager(configDir);
  return {
    'list-jobs':   () => registry.list(),

    'get-job':     (p) => registry.get((p as { id: string }).id),

    /*
     * Every one of these hands the change to the scheduler.
     *
     * They used to write the registry and log to the audit, and stop. The scheduler only read the
     * registry in start(), so a job added, removed, enabled, disabled or edited while the daemon was
     * running had no effect on what the daemon would actually do until the next restart.
     *
     * For a cron job that was merely late. For a `once` job it meant never: its single moment passed
     * with the daemon oblivious, and the job sat in the registry unfired. Reproduced with a 15s
     * delay - due at 20:37:09, still listed and still unrun at 20:37:32.
     */
    'add-job':     (p) => {
      registry.add(p as Partial<Job>);
      const added = registry.get((p as { id: string }).id)!;
      scheduler.scheduleJob(added);
      audit?.log('job.added', { jobId: added.id, label: added.label, type: added.type });
      return added;
    },

    'remove-job':  (p) => {
      const id = (p as { id: string }).id;
      const job = registry.get(id);
      registry.remove(id);
      // Before the registry write would be wrong too: an unscheduled-then-failed-removal leaves a
      // job that exists and never fires.
      scheduler.unscheduleJob(id);
      audit?.log('job.deleted', { jobId: id, label: job?.label, type: job?.type });
    },

    'enable-job':  (p) => {
      const id = (p as { id: string }).id;
      registry.enable(id);
      const job = registry.get(id);
      // Re-enabling has to put the job back on the clock, or it stays enabled and idle.
      if (job) {
        scheduler.scheduleJob(job);
      }
      audit?.log('job.enabled', { jobId: id, label: job?.label });
    },

    'disable-job': (p) => {
      const id = (p as { id: string }).id;
      const job = registry.get(id);
      registry.disable(id);
      // Otherwise a disabled cron job keeps firing until the next restart.
      scheduler.unscheduleJob(id);
      audit?.log('job.disabled', { jobId: id, label: job?.label });
    },

    'edit-job':    (p) => {
      const { id, updates, unset } = p as { id: string; updates?: Partial<Job>; unset?: string[] };
      // Validated before anything is written. orch-server used to flatten the body into the payload,
      // so `updates` was undefined: registry.edit spread nothing and wrote the job back unchanged,
      // then Object.keys(undefined) threw "Cannot convert undefined or null to object". A caller got
      // a TypeError naming nothing, after a pointless write. Both halves are worth refusing.
      if (typeof id !== 'string' || id === '') {
        throw new Error('edit-job requires a string `id`');
      }
      // A clear needs no updates, so `unset` alone is a complete edit; anything else must bring one.
      if (unset !== undefined && (!Array.isArray(unset) || unset.some((f) => typeof f !== 'string'))) {
        throw new Error(
          'edit-job `unset` must be an array of field names, e.g. { id, unset: ["cwd"] }; '
          + `got ${JSON.stringify(unset)}`,
        );
      }
      const fields = updates ?? (Array.isArray(unset) ? {} : undefined);
      if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
        throw new Error(
          'edit-job requires an `updates` object, e.g. { id, updates: { label: "New name" } }; '
          + `got ${fields === undefined ? 'nothing' : JSON.stringify(fields)}`,
        );
      }
      registry.edit(id, fields, unset ?? []);
      const updatedJob = registry.get(id);
      // An edited schedule has to replace the running one. scheduleJob clears the old timer or cron
      // task first, so editing a job does not leave two.
      if (updatedJob) {
        scheduler.scheduleJob(updatedJob);
      }
      audit?.log('job.edited', {
        jobId: id, label: updatedJob?.label,
        changes: Object.keys(fields), ...(unset?.length ? { unset } : {}),
      });
      return updatedJob!;
    },

    'trigger-job': (p) => {
      const { id, ip, userAgent, wait } = p as { id: string; ip?: string; userAgent?: string; wait?: boolean };
      const job = registry.get(id);
      audit?.log('job.triggered_manual', { jobId: id, label: job?.label, ip, userAgent });
      events?.publish('job.triggered_manual', { jobId: id, label: job?.label ?? id, ip: ip ?? null, userAgent: userAgent ?? null });
      // The CLI has always sent `wait`; it used to be dropped here, so --wait silently did nothing.
      return scheduler.trigger(id, { kind: 'manual', ip, userAgent }, wait === true);
    },

    // Awaited, not fired off: the reply's `killed` flag is what the CLI and the dashboard show,
    // so returning before the tree is down would report a kill that had not happened.
    'kill-job': async (p: unknown) => {
      const { id, ip, userAgent } = p as { id: string; ip?: string; userAgent?: string };
      const job = registry.get(id);
      audit?.log('job.killed_manual', { jobId: id, label: job?.label, ip, userAgent });
      events?.publish('job.killed_manual', { jobId: id, label: job?.label ?? id, ip: ip ?? null, userAgent: userAgent ?? null });
      return scheduler.killJob(id);
    },

    'skip-next-firing': (p) => {
      const { id } = p as { id: string };
      const job = registry.get(id);
      scheduler.skipNextFiring(id);
      audit?.log('job.skip_next_firing', { jobId: id, label: job?.label });
      return {};
    },

    'list-state': () => state.getAll(),

    'list-failures': () => state.getUnacknowledgedFailures(),

    'ack-failures': () => { state.acknowledgeAll(); trayManager?.clearFailures(); return {}; },

    'tray-list': () => [...TRAY_ACTIONS],

    'tray-action': (p) => {
      const id = (p as { id?: string })?.id ?? '';
      if (!trayManager) return { ok: false, error: 'Tray not running (daemon started without tray)' };
      return trayManager.triggerAction(id);
    },

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

    'exec-run': (p) => {
      if (!execManager) throw new Error('ExecManager not initialized');
      const { command, cwd, timeout, env, label } = p as {
        command: string; cwd?: string; timeout?: number; env?: Record<string, string>; label?: string;
      };
      if (!command?.trim()) throw new Error('command is required');
      return execManager.fireExec(command, { cwd, timeout, env, label });
    },
    'exec-status': (p) => {
      if (!execManager) throw new Error('ExecManager not initialized');
      return execManager.get((p as { runId: string }).runId) ?? { error: 'not-found' };
    },
    'exec-list': () => execManager?.list() ?? [],
    'exec-kill': (p) => {
      return { ok: execManager?.kill((p as { runId: string }).runId) ?? false };
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
