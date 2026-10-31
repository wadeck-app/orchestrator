import type { LoadFailure } from '@wadeck-app/dsl-renderer';

/**
 * With the daemon down every API route answers 503 {error:'daemon-not-running'}, and the renderer reports the failed source
 * with a generic red banner that has no action in it. A page that carries DaemonStatus already shows a message with the command
 * to run (`orch start`) about the daemon as a whole: there the generic banner is a second red message for the same fact.
 * The job page counts too, through its run history table: given the failure of its source (`loadError: $ctx.$sourceErrors.<source>`)
 * the table says "Cannot be read: the daemon is not running (orch start)" instead of "No runs yet", and ResourceHistory says it for
 * the charts. A page without any of these keeps the generic banner, so that none is ever silent (schedule and audit also bind
 * `loadError`, but are deliberately kept on the banner: add their component here to change that).
 */
const COMPONENTS_THAT_SAY_THE_DAEMON_IS_DOWN: readonly RegExp[] = [
  /\bDaemonStatus\b/,
  // A RunHistory node (up to the next sibling node) that carries loadError bound to a source failure.
  /\$type:\s*RunHistory\b(?:(?!\n\s*- \$type)[\s\S])*?\bloadError:\s*\$ctx\.\$sourceErrors\./,
];

/** True when the page's own components tell the reader the daemon is not running and how to start it. */
export function pageTellsDaemonDown(yamlText: string): boolean {
  return COMPONENTS_THAT_SAY_THE_DAEMON_IS_DOWN.some(says => says.test(yamlText));
}

function isDaemonDown(failure: LoadFailure): boolean {
  return failure.status === 503 && failure.message.includes('daemon-not-running');
}

/** The `shouldNotifyLoadFailure` of a page: false only for "the daemon is down" on a page that says it by itself. */
export function shouldNotifyLoadFailureFor(yamlText: string): (failure: LoadFailure) => boolean {
  const pageSaysIt = pageTellsDaemonDown(yamlText);
  return (failure) => !(pageSaysIt && isDaemonDown(failure));
}
