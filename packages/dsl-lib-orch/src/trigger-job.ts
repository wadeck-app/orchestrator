import { isTriggerRefused, type TriggerRefused } from './types.js';
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
