import { APP_CORE_SHELL_GLOBAL, appFetcher, elevate } from '@wadeck-app/app-core-sdk/shell';
import { getApiBase } from './runtime-config.js';
import { readErrorSentence } from './trigger-job.js';

/**
 * Whether this code runs inside the app-core shell. Only there the sensitive routes of the module (job delete) can be
 * reached: the shell's fetcher is what carries the access token and asks the user for the PIN. orch-app has no shell
 * and no PIN, and its server takes the plain request.
 */
function inShell(): boolean {
  return typeof Reflect.get(globalThis, APP_CORE_SHELL_GLOBAL) === 'object' && Reflect.get(globalThis, APP_CORE_SHELL_GLOBAL) !== null;
}

/**
 * Deletes a job definition (`DELETE /api/jobs/:id`), which app-core serves only to a user who gave the PIN.
 *
 * Inside the shell it goes through the shell's fetcher, which asks for the PIN and repeats the request; a bare `fetch`
 * there answers 401 `elevation-required` with no dialog. Rejects when the deletion did not happen (PIN cancelled, route
 * refused, daemon down), so the caller must not act as if the job were gone.
 */
export async function deleteJob(id: string, apiBase = getApiBase()): Promise<void> {
  const path = `${apiBase}/api/jobs/${encodeURIComponent(id)}`;
  if (inShell()) {
    await appFetcher(`DELETE ${path}`);
    return;
  }
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await readErrorSentence(res));
  }
}

/**
 * Asks for the PIN once before a batch of job writes, so N deletions do not each open a dialog. Nothing to do outside the
 * shell.
 */
export async function elevateForJobWrites(): Promise<void> {
  if (inShell()) {
    await elevate();
  }
}
