import path   from 'node:path';
import os     from 'node:os';
import fs     from 'node:fs';

import { createDaemon } from '@wadeck-app/singleton-daemon-kit';

import { Registry }    from './registry.js';
import { State }       from './state.js';
import { cleanTmpDir, getErrorMessage } from './fsUtil.js';
import { Scheduler }   from './scheduler.js';
import { DailyLogger } from './logger.js';
import { makeCommands } from './commands.js';
import { AuditLogger } from './audit.js';
import { TrayManager } from './tray-manager.js';
import { EventPublisher } from './event-publisher.js';
import { DashboardManager } from './dashboard-manager.js';
import { findOrchServerBinary } from './dashboard-binary.js';

import type { OrchestratorCommands } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

const CONFIG_DIR: string =
  process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator');

async function main(): Promise<void> {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  cleanTmpDir(path.join(CONFIG_DIR, 'tmp'), { maxAgeDays: 7, maxSizeMb: 100 });

  // Init updateManager before try/finally so scheduleUpdate fires even on crash paths.
  // @wadeck-app/shared-cli is ESM-only - use dynamic import() from a CJS module context.
  const { UpdateManager } = await import('@wadeck-app/shared-cli');
  const updateManager = new UpdateManager('@wadeck-app/orchestrator-cli', CONFIG_DIR);

  let updateScheduled = false;
  const scheduleUpdate = (): void => {
    if (updateScheduled) return;
    updateScheduled = true;
    updateManager.scheduleBackgroundUpdate(process.argv[1] ?? '', 'orchestrator-updater.cjs');
  };

  // Create the logger before try/finally so crash paths can always write to it.
  const daemonLog = new DailyLogger(path.join(CONFIG_DIR, 'logs', 'daemon'), 'daemon');

  // Capture uncaught exceptions and unhandled rejections that bypass main()'s catch.
  process.on('uncaughtException', (err: Error) => {
    daemonLog.write(`daemon crash (uncaughtException): ${getErrorMessage(err)}`);
    daemonLog.close();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    daemonLog.write(`daemon crash (unhandledRejection): ${getErrorMessage(reason)}`);
    daemonLog.close();
    process.exit(1);
  });

  try {
    daemonLog.write(`daemon starting (pid=${process.pid})`);

    const registry    = new Registry(path.join(CONFIG_DIR, 'registry.json'));
    const state       = new State(path.join(CONFIG_DIR, 'state.json'));
    const audit       = new AuditLogger(CONFIG_DIR);
    const events      = new EventPublisher();
    const scheduler   = new Scheduler(registry, state, { configDir: CONFIG_DIR, eventPublisher: events });

    audit.log('daemon.start', { pid: process.pid, version });
    events.publish('daemon.started', { pid: process.pid, version });

    let dashboardManager: DashboardManager | null = null;
    try {
      const serverBinary = findOrchServerBinary();
      dashboardManager = new DashboardManager(CONFIG_DIR, serverBinary);
    } catch {
      // orch-server not built yet -- dashboard unavailable
    }

    const trayManager = new TrayManager(CONFIG_DIR, scheduler, state, registry, version, undefined, dashboardManager);

    // Audit job events
    scheduler.on('job-finished', (ev: { id: string; exitCode: number; job: { label: string } }) => {
      audit.log('job.completed', { jobId: ev.id, label: ev.job.label, exitCode: ev.exitCode });
    });

    // Captured in onStart so versionExtra can reference it without a circular dep
    let activePort = 0;

    await createDaemon<OrchestratorCommands>({
      configDir:   CONFIG_DIR,
      appVersion:  version,
      port:        47900,
      commands:    makeCommands(registry, state, scheduler, CONFIG_DIR, trayManager, audit, events),
      // Expose port + uptime in GET /version response for `orch status`
      versionExtra: (): Record<string, unknown> => ({
        port:   activePort,
        uptime: Math.floor(process.uptime()),
      }),
      // Expose active job count in GET /health so the updater can defer during active jobs
      health: () => ({
        status: 'ok' as const,
        active_jobs: Object.values(state.getAll()).filter(entries => entries.some(e => e.exitCode === null)).length,
      }),
      hooks: {
        onStart: (port: number) => {
          activePort = port;
          daemonLog.write(`daemon ready on 127.0.0.1:${port}`);
          console.log(`[orchestrator] daemon started on 127.0.0.1:${port} (pid ${process.pid})`);
        },
        onShutdown: (reason: string) => {
          daemonLog.write(`daemon shutdown: ${reason}`);
          daemonLog.close();
          void scheduler.stop();
          void trayManager.stop();
          void dashboardManager?.stop();
        },
      },
    });

    await scheduler.start();

    trayManager.on('quit',    () => process.exit(0));
    trayManager.on('restart', () => {
      // Write config.restart sentinel so Go launcher restarts the daemon after exit.
      const { writeFileSync } = require('node:fs') as typeof import('node:fs');
      try { writeFileSync(path.join(CONFIG_DIR, 'config.restart'), '1'); } catch { /* ignore */ }
      process.exit(0);
    });
    await trayManager.start();

    // Read and log any update state written by the background updater on previous run.
    const updateState = updateManager.readAndClearState();
    if (updateState) {
      if (updateState.status === 'success') {
        daemonLog.write(`Updated to ${updateState.newVersion ?? '?'} -- restart completed`);
      } else if (updateState.status === 'rolled-back') {
        daemonLog.write(`Update to ${updateState.targetVersion ?? '?'} failed (self-check). Rolled back to ${updateState.previousVersion ?? '?'}`);
      } else if (updateState.status === 'update-failed') {
        daemonLog.write(`Update failed: ${updateState.reason ?? 'unknown'}`);
      }
    }

    // Schedule background update check on startup and every 4h.
    // In dev/test mode (no orchestrator-updater.cjs bundle) this is a no-op.
    // The updater: npm install -g @wadeck/orchestrator-cli@edge -> orch cli self-check -> rollback if failed.
    scheduleUpdate();
    // unref() ensures the interval never prevents the process from exiting on SIGTERM.
    setInterval(() => updateManager.scheduleBackgroundUpdate(process.argv[1] ?? '', 'orchestrator-updater.cjs'), 30 * 60 * 1000).unref();
  } finally {
    // Fire once on crash path; no-op if already scheduled above.
    scheduleUpdate();
  }
}

main().catch((e: unknown) => {
  // Write to a fallback log file since daemonLog may not be initialised yet.
  try {
    const logDir = path.join(CONFIG_DIR, 'logs', 'daemon');
    fs.mkdirSync(logDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const ts    = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(path.join(logDir, `daemon-${today}.log`), `[${ts}] daemon fatal: ${getErrorMessage(e)}\n`);
  } catch { /* last resort */ }
  console.error('[orchestrator] fatal:', getErrorMessage(e));
  process.exit(1);
});
