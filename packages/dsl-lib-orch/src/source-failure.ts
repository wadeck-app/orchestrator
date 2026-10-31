/**
 * A source of the page that failed to load, as the renderer exposes it in `$ctx.$sourceErrors.<source>`.
 * A page hands it to a component as `loadError: $ctx.$sourceErrors.<source>`.
 */
export interface SourceFailure {
  message: string;
  status?: number;
}

/**
 * What a table or list says instead of its "no data" text when its source failed: an empty list and an unreadable one are
 * not the same fact, and "No runs yet" for a job that has runs is a lie. A stopped daemon gets the command that fixes it.
 */
export function cannotBeReadMessage(failure: SourceFailure): string {
  if (failure.status === 503 && failure.message.includes('daemon-not-running')) {
    return 'Cannot be read: the daemon is not running (orch start)';
  }
  return `Cannot be read: ${failure.message}${failure.status === undefined ? '' : ` (HTTP ${failure.status})`}`;
}
