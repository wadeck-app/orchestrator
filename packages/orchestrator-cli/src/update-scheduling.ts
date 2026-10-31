import { isReleaseVersion, devBuildRefusalMessage } from '@wadeck-app/shared-cli/ReleaseVersion';

export interface UpdateSpawner {
  scheduleBackgroundUpdate(bundlePath: string, updaterName: string, currentVersion: string): void;
}

export interface RequestOptions {
  /** Skip the request when one was already made in this run (the startup check). */
  oncePerRun?: boolean;
  /** An explicit user request (tray): the updater bypasses autoUpdate:false through UPDATER_FORCE. */
  force?: boolean;
}

export type RequestResult = 'scheduled' | 'skipped-already' | 'skipped-dev' | 'skipped-suspended';

/**
 * The single place the daemon spawns the updater from (startup, every 30 min, tray). A development build
 * spawns nothing: see devBuildRefusalMessage (shared-cli); the version is also passed to scheduleBackgroundUpdate, which refuses too. Background requests explain it once per run, explicit ones
 * every time, so a person who clicked is never left without an answer.
 */
export function createUpdateScheduler(deps: {
  version: string;
  bundlePath: string;
  manager: UpdateSpawner;
  log: (message: string) => void;
  /**
   * Why the automatic updates are suspended (update-guard.ts), or null. Read at every request: a background request spawns
   * nothing while it answers; an explicit one (tray) still goes through, since a person asked.
   */
  suspended?: () => string | null;
}) {
  let requested = false;
  let devExplained = false;
  let suspensionSaid = false;
  return {
    request(reason: string, opts: RequestOptions = {}): RequestResult {
      if (!isReleaseVersion(deps.version)) {
        if (opts.force || !devExplained) {
          deps.log(`background update check (${reason}) skipped: ${devBuildRefusalMessage('orch', deps.version)}`);
          devExplained = true;
        }
        return 'skipped-dev';
      }
      const suspendedBecause = deps.suspended?.() ?? null;
      if (suspendedBecause !== null && !opts.force) {
        // Said once per run, not at every tick; and before oncePerRun is spent, so a later explicit request is not blocked by it.
        if (!suspensionSaid) {
          deps.log(`background update check (${reason}) refused: ${suspendedBecause}`);
          suspensionSaid = true;
        }
        return 'skipped-suspended';
      }
      if (opts.oncePerRun) {
        if (requested) {
          deps.log(`background update check (${reason}): skipped, already scheduled this run`);
          return 'skipped-already';
        }
        requested = true;
      }
      deps.log(`background update check triggered (${reason})`);
      const previous = process.env['UPDATER_FORCE'];
      if (opts.force) {
        process.env['UPDATER_FORCE'] = '1';
      }
      try {
        deps.manager.scheduleBackgroundUpdate(deps.bundlePath, 'orchestrator-updater.cjs', deps.version);
      } finally {
        if (opts.force) {
          if (previous === undefined) {
            delete process.env['UPDATER_FORCE'];
          } else {
            process.env['UPDATER_FORCE'] = previous;
          }
        }
      }
      return 'scheduled';
    },
  };
}
