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
import { readRunTelemetry } from './run-telemetry.js';
import { readResourceHistory, RESOURCE_HISTORY_DEFAULT_LIMIT, RESOURCE_HISTORY_RETENTION } from './resource-history.js';
import { summarizeTimers } from './scheduler.js';
import type { DaemonConfig } from './daemonConfig.js';
import type { SupervisorState } from './supervised-run.js';
import { estimateProgress } from './progress/engine.js';
import { removeJobData, dropStaleJobData, type JobDataCleanup } from './job-data-cleanup.js';

// Same rule as registry.add and the logs route's path-traversal guard (P-7); do not relax it here.
const JOB_ID_RE = /^[a-z0-9-]+$/i;

/** What get-daemon-info reports that only index.ts knows. */
export interface DaemonInfoSource {
  version: string;
  /** A function because the port is only known once the server listens. */
  port: () => number;
  startedAt: Date;
  config: Required<Pick<DaemonConfig,
    'supervisedJobs' | 'lateActionWindowMinutes' | 'autoUpdate' | 'appCore' | 'catchUpInitialDelaySeconds' | 'catchUpStaggerSeconds'>>;
  supervisor: SupervisorState;
}

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
  daemonInfo?: DaemonInfoSource,
  // The daemon log. Absent in tests that do not look at it.
  log?: (line: string) => void,
  // The clock get-progress reads. Tests inject a fixed one; the daemon keeps the real clock.
  now: () => Date = () => new Date(),
): OrchestratorCommands {
  const secrets = new SecretsManager(configDir);
  // One line per path that could not be deleted: the reply tells the caller, the log tells whoever reads it later.
  const reportLeftovers = (what: string, id: string, cleanup: JobDataCleanup): void => {
    for (const left of cleanup.leftovers) {
      log?.(`${what} job "${id}": not deleted${left.path ? ` ${left.path}` : ''}: ${left.reason}`);
    }
  };
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
      // After registry.add, which refuses a duplicate id: the files of a job that exists are not stale.
      const stale = dropStaleJobData(configDir, added.id, { running: () => scheduler.runningCount(added.id) > 0 });
      const dropped = stale.cleaned.telemetry + stale.cleaned.resourceHistory + stale.cleaned.progress;
      if (dropped > 0) {
        log?.(`added job "${added.id}": dropped ${dropped} telemetry / resource-history / progress file(s) left behind under this id, so the new job starts without another job's history`);
      }
      reportLeftovers('added', added.id, stale);
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
      scheduler.unscheduleJob(id, { forgetRestarts: true });
      // A running instance is not stopped by a removal: what it is still writing stays (see removeJobData).
      const running = scheduler.runningCount(id) > 0;
      const cleanup = removeJobData(configDir, id, { running });
      if (!running) {
        state.clear(id);
      }
      reportLeftovers('removed', id, cleanup);
      audit?.log('job.deleted', { jobId: id, label: job?.label, type: job?.type, cleaned: cleanup.cleaned });
      // Only said when something is left, so a caller that ignores the reply loses nothing.
      return cleanup.leftovers.length > 0 ? { leftovers: cleanup.leftovers } : undefined;
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
      scheduler.unscheduleJob(id, { forgetRestarts: true });
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
      const cleared = registry.edit(id, fields, unset ?? []);
      const updatedJob = registry.get(id);
      // An edited schedule has to replace the running one. scheduleJob clears the old timer or cron
      // task first, so editing a job does not leave two.
      if (updatedJob) {
        scheduler.scheduleJob(updatedJob);
      }
      audit?.log('job.edited', {
        jobId: id, label: updatedJob?.label,
        changes: Object.keys(fields), ...(unset?.length ? { unset } : {}),
        // Said in the trail: a type change that dropped fields (cron to manual drops the schedule) must not look like a plain edit.
        ...(cleared.length ? { clearedForType: cleared, note: `type ${updatedJob?.type}: dropped ${cleared.join(', ')}, which no longer apply` } : {}),
      });
      return updatedJob!;
    },

    'trigger-job': (p) => {
      const { id, ip, userAgent, wait, force } = p as { id: string; ip?: string; userAgent?: string; wait?: boolean; force?: boolean };
      // Refused before anything is recorded: this used to audit first, so 12 550 requests naming no
      // job at all (`"jobId":""`) went into the trail as manual triggers.
      if (typeof id !== 'string' || !JOB_ID_RE.test(id)) {
        throw new Error(
          `trigger-job needs a job id made of letters, digits and "-" (got ${JSON.stringify(id)}). `
          + 'Run `orch list` to see the available job ids.',
        );
      }
      const job = registry.get(id);
      if (!job) {
        throw new Error(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`);
      }
      audit?.log('job.triggered_manual', { jobId: id, label: job.label, ip, userAgent });
      events?.publish('job.triggered_manual', { jobId: id, label: job?.label ?? id, ip: ip ?? null, userAgent: userAgent ?? null });
      // The CLI has always sent `wait`; it used to be dropped here, so --wait silently did nothing.
      return scheduler.trigger(id, { kind: 'manual', ip, userAgent }, wait === true, { force: force === true })
        .then((result) => {
          // The line above records that someone asked; this records that nothing started, so the
          // trail does not read as a run that never happened.
          if (result.status === 'already-running') {
            audit?.log('job.trigger_refused', {
              jobId: id, label: job.label, reason: 'concurrency',
              running: result.running, maxConcurrency: result.maxConcurrency, ip, userAgent,
            });
          }
          return result;
        });
    },

    // Awaited, not fired off: the reply's `killed` flag is what the CLI and the dashboard show,
    // so returning before the tree is down would report a kill that had not happened.
    'kill-job': async (p: unknown) => {
      const { id, ip, userAgent } = (p ?? {}) as { id?: unknown; ip?: string; userAgent?: string };
      // Refused before anything is recorded or published: a request without a job id used to reach the audit trail and the
      // queue as a kill request for "undefined" (job.kill_requested requires a jobId). Only the shape is checked, not
      // JOB_ID_RE: a job registered under an older, looser id rule must stay stoppable.
      if (typeof id !== 'string' || id === '') {
        throw new Error(
          `kill-job needs a job id (got ${JSON.stringify(id)}). `
          + 'Run `orch list` to see the available job ids.',
        );
      }
      const job = registry.get(id);
      audit?.log('job.killed_manual', { jobId: id, label: job?.label, ip, userAgent });
      // A request, not an end: the stopped run ends with the scheduler's job.killed_manual (terminal), which must stay the only one.
      events?.publish('job.kill_requested', { jobId: id, label: job?.label ?? id, ip: ip ?? null, userAgent: userAgent ?? null });
      return scheduler.killJob(id);
    },

    /*
     * Ends every running instance of the job, waits until it is gone, starts a new run. Generic: any job, not only
     * a long-running one (timeoutSeconds 0); that restriction belongs to the dashboard button.
     *
     * The ended runs keep the record `kill-job` gives them (cancelledByUser, reason manual-kill): the scheduler
     * announces that itself, so this only adds the one line saying a restart was asked for and what came of it.
     * Written after the work, not before like its neighbours, because wasRunning and killed are only known then.
     */
    'restart-job': async (p: unknown) => {
      const { id, ip, userAgent } = (p ?? {}) as { id?: unknown; ip?: string; userAgent?: string };
      if (typeof id !== 'string' || !JOB_ID_RE.test(id)) {
        throw new Error(
          `restart-job needs a job id made of letters, digits and "-" (got ${JSON.stringify(id)}). `
          + 'Run `orch list` to see the available job ids.',
        );
      }
      const job = registry.get(id);
      if (!job) {
        throw new Error(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`);
      }
      if (!job.enabled) {
        throw new Error(`Job "${id}" is disabled, so it is not restarted. Enable it with \`orch enable ${id}\` first.`);
      }
      if (job.spent === true) {
        throw new Error(
          `Job "${id}" is a one-shot job that already ran, so there is nothing to restart. `
          + `Run it again with \`orch trigger ${id}\`.`,
        );
      }
      const result = await scheduler.restartJob(id, { kind: 'manual', ip, userAgent });
      audit?.log('job.restarted', {
        jobId: id, label: job.label, wasRunning: result.wasRunning, killed: result.killed,
        started: result.started, ...(result.skipped === undefined ? {} : { skipped: result.skipped }), ip, userAgent,
      });
      events?.publish('job.restarted', {
        jobId: id, label: job.label, wasRunning: result.wasRunning, killed: result.killed,
        started: result.started, ip: ip ?? null, userAgent: userAgent ?? null,
      });
      return { id, ...result };
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

    /*
     * With { jobId } acknowledges that job's failure, without it all of them. The tray lists failures
     * itself and can only be cleared whole, so it is cleared once nothing is left to show.
     */
    'ack-failures': (p) => {
      const jobId = (p as { jobId?: unknown } | undefined)?.jobId;
      if (jobId !== undefined && typeof jobId !== 'string') {
        throw new Error('ack-failures: jobId must be a string when given (omit it to acknowledge every failure)');
      }
      if (jobId === undefined) {
        state.acknowledgeAll();
      } else {
        state.acknowledge(jobId);
      }
      if (state.getUnacknowledgedFailures().length === 0) {
        trayManager?.clearFailures();
      }
      return {};
    },

    'tray-list': () => [...TRAY_ACTIONS],

    'tray-action': (p) => {
      const id = (p as { id?: string })?.id ?? '';
      if (!trayManager) {
        return { ok: false, error: 'Tray not running (daemon started without tray)' };
      }
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

    /*
     * Progress and ETA of the jobs that have an open run; see progress/engine.ts. Advisory: nothing here touches a
     * run. A bad payload or an unknown job is refused with the fix, never answered with an empty object.
     */
    'get-progress': (p) => {
      const jobIds = (p as { jobIds?: unknown } | undefined)?.jobIds;
      if (jobIds !== undefined) {
        if (!Array.isArray(jobIds)) {
          throw new Error('get-progress: jobIds must be an array of job ids, or omitted for every running job.');
        }
        for (const id of jobIds) {
          if (typeof id !== 'string' || !JOB_ID_RE.test(id)) {
            throw new Error(`get-progress: ${JSON.stringify(id)} is not a valid job id (letters, digits and dashes only).`);
          }
          if (!registry.get(id)) {
            throw new Error(`Job not found: "${id}". Run \`orch list\` to see the available job ids.`);
          }
        }
      }
      return estimateProgress({
        configDir,
        jobs: registry.list(),
        history: state.getAll(),
        now,
        ...(jobIds ? { jobIds: jobIds as string[] } : {}),
        log: (line) => { try { process.stderr.write(`${line}\n`); } catch { /* EPIPE */ } },
      });
    },

    'get-resource-baseline': (p) => {
      const { jobId } = p as { jobId: string };
      return state.getResourceBaseline(jobId) ?? null;
    },

    'get-run-telemetry': (p) => {
      const { jobId, run } = (p ?? {}) as { jobId?: unknown; run?: unknown };
      if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
        throw new Error(
          `get-run-telemetry needs a job id made of letters, digits and "-" (got ${JSON.stringify(jobId)}). `
          + 'Run `orch list` to see the available job ids.',
        );
      }
      if (!registry.get(jobId)) {
        throw new Error(`Job not found: "${jobId}". Run \`orch list\` to see the available job ids.`);
      }
      if (run !== undefined && (typeof run !== 'string' || run === '')) {
        throw new Error(`get-run-telemetry: run must be a run's startedAt (an ISO timestamp as shown in the run history), got ${JSON.stringify(run)}.`);
      }
      return readRunTelemetry(configDir, jobId, run);
    },

    'get-resource-history': (p) => {
      const { jobId, limit } = (p ?? {}) as { jobId?: unknown; limit?: unknown };
      if (typeof jobId !== 'string' || !JOB_ID_RE.test(jobId)) {
        throw new Error(
          `get-resource-history needs a job id made of letters, digits and "-" (got ${JSON.stringify(jobId)}). `
          + 'Run `orch list` to see the available job ids.',
        );
      }
      if (!registry.get(jobId)) {
        throw new Error(`Job not found: "${jobId}". Run \`orch list\` to see the available job ids.`);
      }
      if (limit !== undefined
        && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > RESOURCE_HISTORY_RETENTION)) {
        throw new Error(
          `get-resource-history: limit must be a whole number from 1 to ${RESOURCE_HISTORY_RETENTION} (got: ${JSON.stringify(limit)}).`,
        );
      }
      return readResourceHistory(configDir, jobId, limit ?? RESOURCE_HISTORY_DEFAULT_LIMIT);
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

    /*
     * What is actually armed, beside what the registry asks for.
     *
     * Deliberately not filtered the way get-schedule is: this exists to expose the jobs whose intent
     * and reality disagree, and every one of those would be filtered out by an `enabled && schedule`
     * guard. A job that is silently not armed is exactly the one to show.
     */
    'list-timers': () => scheduler.inspectTimers(),

    /*
     * The daemon's own status, for the dashboard. Built field by field: the config is the six keys that
     * explain behaviour, and nothing of a job (command, env, cwd) or a secret is read here.
     */
    'get-daemon-info': () => {
      if (!daemonInfo) {
        throw new Error('get-daemon-info: this daemon was started without its daemon info source (a wiring bug in index.ts); restart it with `orch restart`.');
      }
      const c = daemonInfo.config;
      return {
        version:       daemonInfo.version,
        pid:           process.pid,
        port:          daemonInfo.port(),
        startedAt:     daemonInfo.startedAt.toISOString(),
        uptimeSeconds: Math.max(0, Math.floor((Date.now() - daemonInfo.startedAt.getTime()) / 1000)),
        config: {
          supervisedJobs:             c.supervisedJobs,
          lateActionWindowMinutes:    c.lateActionWindowMinutes,
          autoUpdate:                 c.autoUpdate,
          appCore:                    c.appCore,
          catchUpInitialDelaySeconds: c.catchUpInitialDelaySeconds,
          catchUpStaggerSeconds:      c.catchUpStaggerSeconds,
        },
        supervisor: { ...daemonInfo.supervisor },
        runs:       scheduler.runCounts(),
        scheduler:  summarizeTimers(scheduler.inspectTimers()),
        pendingRestarts: scheduler.pendingRestarts(),
      };
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
      if (!execManager) {
        throw new Error('ExecManager not initialized');
      }
      const { command, cwd, timeout, env, label } = p as {
        command: string; cwd?: string; timeout?: number; env?: Record<string, string>; label?: string;
      };
      if (!command?.trim()) {
        throw new Error('command is required');
      }
      return execManager.fireExec(command, { cwd, timeout, env, label });
    },
    'exec-status': (p) => {
      if (!execManager) {
        throw new Error('ExecManager not initialized');
      }
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
