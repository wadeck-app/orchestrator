import type { LoadFailure } from '@wadeck-app/dsl-renderer';

/**
 * With the daemon down every API route answers 503 {error:'daemon-not-running'}, and the renderer reports the failed source
 * with a generic red banner that has no action in it. A page that carries DaemonStatus already shows a message with the command
 * to run (`orch start`) about the daemon as a whole: there the generic banner is a second red message for the same fact.
 * A page without it keeps the generic banner, so that none is ever silent. ResourceHistory does not count: its message covers
 * the charts only, and without the banner the run history table of a job page reads "No runs yet" for a job that has runs.
 */
const COMPONENTS_THAT_SAY_THE_DAEMON_IS_DOWN = /\bDaemonStatus\b/;

/** True when the page's own components tell the reader the daemon is not running and how to start it. */
export function pageTellsDaemonDown(yamlText: string): boolean {
  return COMPONENTS_THAT_SAY_THE_DAEMON_IS_DOWN.test(yamlText);
}

function isDaemonDown(failure: LoadFailure): boolean {
  return failure.status === 503 && failure.message.includes('daemon-not-running');
}

/** The `shouldNotifyLoadFailure` of a page: false only for "the daemon is down" on a page that says it by itself. */
export function shouldNotifyLoadFailureFor(yamlText: string): (failure: LoadFailure) => boolean {
  const pageSaysIt = pageTellsDaemonDown(yamlText);
  return (failure) => !(pageSaysIt && isDaemonDown(failure));
}
