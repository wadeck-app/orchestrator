import { getErrorMessage } from './fsUtil.js';

interface Stoppable<R> { stop(reason?: R): Promise<void> }

/**
 * Makes `handle.stop()` wait for `flush()` first.
 *
 * The daemon kit's `onShutdown` hook is synchronous, so the pushes in flight can only be awaited before the kit is asked
 * to stop. The kit's SIGTERM/SIGINT, `/quit` and idle paths all reach `handle.stop(...)` through the handle, so replacing
 * it covers them. `flush` is expected to be bounded; a failure is logged and never prevents the stop.
 */
export function flushBeforeStop<R>(handle: Stoppable<R>, flush: () => Promise<void>, log?: (line: string) => void): void {
  const kitStop = handle.stop.bind(handle);
  let flushing: Promise<void> | null = null;
  handle.stop = async (reason?: R): Promise<void> => {
    flushing ??= flush().catch((err: unknown) => {
      log?.(`events: could not flush before stopping: ${getErrorMessage(err)}`);
    });
    await flushing;
    await kitStop(reason);
  };
}
