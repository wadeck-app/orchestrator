import type { DaemonInfo, RuntimeEntry } from './types.js';

/** Ids of the jobs with a run still going that no supervisor owns: the ones that die with the daemon. */
export function unsupervisedRunning(state: Record<string, RuntimeEntry[]>): string[] {
  const ids: string[] = [];
  for (const [id, entries] of Object.entries(state)) {
    const open = entries.filter(e => e.finishedAt == null && e.exitCode == null);
    if (open.length > 0 && !open.every(e => e.supervised === true)) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * The warning printed before a command that ends the daemon (`stop`, `restart`, `cli update`), or null when nothing
 * is lost: the supervisor is active (running jobs outlive the daemon) or no unsupervised job is running.
 * `action` completes "<action> will kill ...". Warn, never ask: scripts call these commands.
 */
export function unsupervisedWarning(
  action: string,
  supervisor: DaemonInfo['supervisor'],
  state: Record<string, RuntimeEntry[]>,
  platform: string,
): string | null {
  if (supervisor.active) {
    return null;
  }
  const dying = unsupervisedRunning(state);
  if (dying.length === 0) {
    return null;
  }
  const reason = supervisor.requested
    ? (supervisor.note ?? 'The supervisor is unavailable and no reason was reported; check: orch logs')
    : 'supervisedJobs is false in config.yml.';
  let wayOut: string;
  if (platform === 'linux') {
    wayOut = 'There is no supervisor in the npm install on Linux (linux-x64 has one only when running from a source checkout, linux-arm64 never), '
      + 'so the only choices are to wait for the jobs to finish (see: orch status) or to accept their loss.';
  } else if (!supervisor.requested) {
    wayOut = 'To supervise the runs started from now on, set supervisedJobs: true in config.yml and run: orch restart. '
      + 'Until then, wait for the jobs to finish (see: orch status) or accept their loss.';
  } else {
    wayOut = 'The supervisor should have shipped with this install: reinstall with: orch cli update. '
      + 'Until then, wait for the jobs to finish (see: orch status) or accept their loss.';
  }
  return `warning: ${action} will kill ${dying.length} running job(s) with the daemon, because they are not supervised: ${dying.join(', ')}.\n`
    + `  They are killed with the daemon and are not followed again afterwards. ${reason}\n`
    + `  ${wayOut}`;
}
