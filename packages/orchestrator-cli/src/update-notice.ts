// What `orch` and the daemon say about update-state.json. Pure, so the wording is testable.

/** A record older than this is dead whatever its pid says (pid reuse); same bound as shared-updater's repair. */
export const APPLYING_STALE_MS = 15 * 60 * 1000;

/** The slice of shared-cli's UpdateState that is read here. */
export interface UpdateStateLike {
  status: string;
  pid?: number;
  /** The npm child of the updater, journaled by shared-updater from 2026.10.25-020. */
  npmPid?: number;
  npmStartedAt?: number;
  targetVersion?: string;
  newVersion?: string;
  previousVersion?: string;
  error?: string;
  reason?: string;
  timestamp?: number;
}

export interface UpdateNotice {
  level: 'info' | 'warn';
  text: string;
}

export interface UpdateNoticeOptions {
  now?: number;
  isAlive?: (pid: number) => boolean;
}

/** EPERM means the process exists and is not ours: alive. Only ESRCH (or a bad pid) means gone. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function updateNotice(state: UpdateStateLike | null, opts: UpdateNoticeOptions = {}): UpdateNotice | null {
  if (!state) {
    return null;
  }
  const { status } = state;
  if (status === 'success') {
    return { level: 'info', text: `Updated to v${state.targetVersion ?? state.newVersion ?? '?'}` };
  }
  if (status === 'rolled-back') {
    return { level: 'warn', text: `Rollback to v${state.previousVersion ?? '?'}` };
  }
  if (status === 'failed' || status === 'update-failed') {
    return { level: 'warn', text: `Update failed (${state.error ?? state.reason ?? 'unknown'})` };
  }
  if (status === 'applying') {
    return applyingNotice(state, opts);
  }
  // 'update-available', 'deferred' and the like are not news for the reader of this notice.
  return null;
}

function applyingNotice(state: UpdateStateLike, opts: UpdateNoticeOptions): UpdateNotice {
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? isPidAlive;
  const target = state.targetVersion ?? state.newVersion ?? '?';
  const age = typeof state.timestamp === 'number' ? now - state.timestamp : Number.POSITIVE_INFINITY;
  const running = typeof state.pid === 'number' && age <= APPLYING_STALE_MS && isAlive(state.pid);
  if (running) {
    return { level: 'info', text: `An update to v${target} is in progress (pid ${state.pid}).` };
  }
  // The updater journals 'applying' before npm runs: a record whose updater is gone is an install that was
  // killed, possibly with the old package already removed. The next updater run repairs it.
  const orphanNpm = typeof state.npmPid === 'number' && age <= APPLYING_STALE_MS && isAlive(state.npmPid)
    ? ` Its npm (pid ${state.npmPid}) is still running: the repair waits for it, then stops it.`
    : '';
  return {
    level: 'warn',
    text: `An update to v${target} was interrupted (previous version: v${state.previousVersion ?? '?'}).${orphanNpm} `
      + `The next update run repairs it: run \`orch cli update\` now; if \`orch\` is no longer found, run `
      + `\`npm install -g @wadeck-app/orchestrator-cli@latest\`.`,
  };
}
