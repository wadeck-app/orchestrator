import { isReleaseVersion, devBuildRefusalMessage } from './dev-build-guard.js';

export interface UpdateSpawner {
  scheduleBackgroundUpdate(bundlePath: string, updaterName: string): void;
}

export interface RequestOptions {
  /** Skip the request when one was already made in this run (the startup check). */
  oncePerRun?: boolean;
  /** An explicit user request (tray): the updater bypasses autoUpdate:false through UPDATER_FORCE. */
  force?: boolean;
}

export type RequestResult = 'scheduled' | 'skipped-already' | 'skipped-dev';

/**
 * The single place the daemon spawns the updater from (startup, every 30 min, tray). A development build
 * spawns nothing: see devBuildRefusalMessage. Background requests explain it once per run, explicit ones
 * every time, so a person who clicked is never left without an answer.
 */
export function createUpdateScheduler(deps: {
  version: string;
  bundlePath: string;
  manager: UpdateSpawner;
  log: (message: string) => void;
}) {
  let requested = false;
  let devExplained = false;
  return {
    request(reason: string, opts: RequestOptions = {}): RequestResult {
      if (!isReleaseVersion(deps.version)) {
        if (opts.force || !devExplained) {
          deps.log(`background update check (${reason}) skipped: ${devBuildRefusalMessage(deps.version)}`);
          devExplained = true;
        }
        return 'skipped-dev';
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
        deps.manager.scheduleBackgroundUpdate(deps.bundlePath, 'orchestrator-updater.cjs');
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
