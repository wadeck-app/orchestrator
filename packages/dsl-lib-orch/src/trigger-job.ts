import { isTriggerRefused, type RestartResult, type TriggerRefused } from './types.js';
import { getApiBase } from './runtime-config.js';

async function postRun(
  id: string,
  action: 'trigger' | 'trigger-early',
  opts: { force?: boolean } | undefined,
  apiBase: string,
): Promise<void | TriggerRefused> {
  const query = opts?.force === true ? '?force=true' : '';
  const res = await fetch(`${apiBase}/api/jobs/${id}/${action}${query}`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  if (res.status === 200) {
    const body: unknown = await res.json();
    if (isTriggerRefused(body)) {
      return body;
    }
  }
}

/**
 * Asks the dashboard server to run a job now.
 *
 * Resolves with nothing when the run started, and with the refusal when the job is already at its
 * concurrency limit: that is an outcome the caller has to show, not an error to throw. A failed
 * request does throw, with the server's own message, so it cannot be mistaken for a success.
 *
 * `force` starts another instance past the limit; callers pass it only after the user has seen the
 * refusal and chosen to go ahead.
 */
export function postTrigger(
  id: string,
  opts?: { force?: boolean },
  apiBase = getApiBase(),
): Promise<void | TriggerRefused> {
  return postRun(id, 'trigger', opts, apiBase);
}

/** What the daemon answers to a dry run: started (pid), or already finished (exitCode, for a job that waits). */
export type DryRunResult = { pid: number | null } | { exitCode: number | null };

/**
 * Asks the dashboard server to run the job's command with `--dry-run` appended (the job must declare
 * dryRunSupported). Rejects with the server's own message on a failed request AND when the daemon
 * answers 200 with `{ error }` (the job does not support it), so a refusal cannot read as a start.
 */
export async function postDryRun(id: string, apiBase = getApiBase()): Promise<DryRunResult> {
  const res = await fetch(`${apiBase}/api/jobs/${id}/dry-run`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  const body = await res.json() as DryRunResult | { error: string };
  if ('error' in body) {
    throw new Error(body.error);
  }
  return body;
}

/**
 * Asks the dashboard server to restart a job: end its running instances, wait until they are gone, start it
 * again. Resolves with the daemon's answer, a refused start included (`started: false` with a `reason`: the old
 * instance is gone and the caller has to say so). Rejects with the server's own message when the request fails
 * or the daemon refuses the job itself (unknown, disabled, spent).
 */
export async function postRestart(id: string, apiBase = getApiBase()): Promise<RestartResult> {
  const res = await fetch(`${apiBase}/api/jobs/${id}/restart`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? res.statusText);
  }
  return await res.json() as RestartResult;
}

/**
 * Same contract as `postTrigger`, for "run it now instead of at its next scheduled time".
 *
 * The server skips the scheduled occurrence only once the run started, so a refusal leaves it owed.
 */
export function postTriggerEarly(
  id: string,
  opts?: { force?: boolean },
  apiBase = getApiBase(),
): Promise<void | TriggerRefused> {
  return postRun(id, 'trigger-early', opts, apiBase);
}
