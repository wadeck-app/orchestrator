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
  if (!supervisor.requested) {
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

/** The part of an `orch exec` run (exec-manager.ts `ExecRun`) the warning reads. */
export interface ExecRunView {
  runId: string;
  command: string;
  startedAt: string;
  status: string;
}

/** The exec commands still running. */
export function execRunning(runs: ExecRunView[]): ExecRunView[] {
  return runs.filter(r => r.status === 'running');
}

const COMMAND_WIDTH = 80;

function runningFor(startedAt: string, nowMs: number): string {
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return '??';
  }
  const s = Math.max(0, Math.round((nowMs - startedMs) / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m${String(s % 60).padStart(2, '0')}s`;
  }
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The warning about the running `orch exec` commands, or null when none runs. Unlike jobs they are never supervised
 * (exec-manager.ts spawns them as plain children of the daemon), so this holds whatever the supervisor says and
 * `supervisedJobs` is no way out. Warn, never ask.
 */
export function execWarning(action: string, runs: ExecRunView[], nowMs: number): string | null {
  const dying = execRunning(runs);
  if (dying.length === 0) {
    return null;
  }
  const lines = dying.map((r) => {
    const oneLine = r.command.replace(/\s+/g, ' ').trim();
    const command = oneLine.length > COMMAND_WIDTH ? `${oneLine.slice(0, COMMAND_WIDTH)}...` : oneLine;
    return `  ${r.runId}  running for ${runningFor(r.startedAt, nowMs)}  ${command}`;
  });
  return `warning: ${action} will kill ${dying.length} running exec command(s) with the daemon: orch exec commands are never supervised.\n`
    + `${lines.join('\n')}\n`
    + '  They are killed with the daemon and are not started again. Wait for them to finish or accept their loss.';
}
