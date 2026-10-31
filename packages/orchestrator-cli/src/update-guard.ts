import fs from 'node:fs';
import { isReleaseVersion } from '@wadeck-app/shared-cli/ReleaseVersion';
import { atomicWriteJson, getErrorMessage } from './fsUtil.js';
import type { UpdateStateLike } from './update-notice.js';

/**
 * Two guards against an update that never takes effect and restarts the daemon again and again.
 *
 * Seen on 2026-10-31: after `nvm use`, the updater installed the new version into the npm prefix of the active node, while the
 * long-lived launcher (started by `orch start`, which fixes LAUNCHER_BUNDLE_OVERRIDE for its whole life) kept starting the bundle
 * of the old node. The daemon ran the old version, found "an update exists", updated, restarted, and found it again: 822
 * restarts in a day, one every ~11 s, with a new tray icon each time. Neither guard needs to know why an update does not take.
 */

/** How many restarts caused by updates, within the window, are too many. */
export const UPDATE_LOOP_LIMIT = 3;
export const UPDATE_LOOP_WINDOW_MS = 30 * 60_000;
export const UPDATE_STARTS_FILE = 'update-starts.json';

/**
 * The update says it installed a version this daemon is not running: the updater and this daemon do not look at the same
 * install, so another update would change nothing and restart the daemon for nothing. Null when there is nothing to say.
 */
export function staleUpdateProblem(runningVersion: string, state: UpdateStateLike | null, bundlePath: string): string | null {
  if (!state || state.status !== 'success' || !isReleaseVersion(runningVersion)) {
    return null;
  }
  const target = state.targetVersion ?? state.newVersion;
  if (target === undefined || target === runningVersion) {
    return null;
  }
  return `an update to v${target} was installed, but this daemon runs v${runningVersion} from ${bundlePath}: the updater installs `
    + 'into the npm prefix of the node that is active now, and this daemon was started from a bundle somewhere else (after a node '
    + 'version switch, for instance). Automatic updates are suspended until it restarts. Fix: orch stop, then orch start, with the '
    + 'node you use now.';
}

/** Restarts caused by updates that are too frequent: a loop, whatever its cause. Null when the rate is fine. */
export function updateStartLoopProblem(starts: readonly number[], now: number): string | null {
  const recent = starts.filter(t => now - t < UPDATE_LOOP_WINDOW_MS);
  if (recent.length < UPDATE_LOOP_LIMIT) {
    return null;
  }
  return `the daemon was restarted ${recent.length} times in the last ${UPDATE_LOOP_WINDOW_MS / 60_000} minutes by updates. `
    + 'Automatic updates are suspended until the oldest of these restarts is that old. `orch cli update` says what is wrong with the '
    + 'install; if it does not, check that the node that runs `orch` is the one the daemon starts under.';
}

/** The record of the starts that followed an update. A file that cannot be read counts as empty and is reported. */
export function loadUpdateStarts(file: string): { starts: number[]; problem: string | null } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { starts: [], problem: null };
    }
    return { starts: [], problem: `${file} cannot be read (${getErrorMessage(e)}); it is treated as empty` };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every(t => typeof t === 'number' && Number.isFinite(t))) {
      return { starts: parsed, problem: null };
    }
    return { starts: [], problem: `${file} does not hold a list of times; it is treated as empty and rewritten` };
  } catch (e) {
    return { starts: [], problem: `${file} is not valid JSON (${getErrorMessage(e)}); it is treated as empty and rewritten` };
  }
}

/** Adds a start to the record, drops what left the window, writes it, and returns what is kept. Throws if it cannot write. */
export function recordUpdateStart(file: string, now: number): number[] {
  const kept = [...loadUpdateStarts(file).starts.filter(t => now - t < UPDATE_LOOP_WINDOW_MS), now];
  atomicWriteJson(file, kept);
  return kept;
}

/**
 * What the daemon does with the update state it reads at start: records the restart when an update caused it, and returns why
 * the automatic updates must be suspended (also written to the log as an error), or null. A stale install wins over a loop,
 * since it names the cause. Never throws: a record that cannot be read or written is reported and the daemon goes on.
 */
export function guardUpdates(opts: {
  version: string;
  state: UpdateStateLike | null;
  bundlePath: string;
  startsFile: string;
  now: number;
  log: (message: string) => void;
}): string | null {
  const { state, log } = opts;
  if (!state) {
    return null;
  }
  let loop: string | null = null;
  if (state.status === 'success') {
    const loaded = loadUpdateStarts(opts.startsFile);
    if (loaded.problem) {
      log(`ERROR ${loaded.problem}`);
    }
    let starts: number[];
    try {
      starts = recordUpdateStart(opts.startsFile, opts.now);
    } catch (e) {
      log(`ERROR ${opts.startsFile} could not be written (${getErrorMessage(e)}): the restarts caused by updates cannot be counted, so the loop guard is limited to this start`);
      starts = [...loaded.starts, opts.now];
    }
    loop = updateStartLoopProblem(starts, opts.now);
  }
  const why = staleUpdateProblem(opts.version, state, opts.bundlePath) ?? loop;
  if (why) {
    log(`ERROR automatic updates suspended: ${why}`);
  }
  return why;
}
