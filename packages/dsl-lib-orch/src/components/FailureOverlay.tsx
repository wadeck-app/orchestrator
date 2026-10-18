import React from 'react';
import { useFailures } from '../hooks/useFailures.js';
import { FailureBanner } from './FailureBanner.js';

export interface FailureOverlayProps {
  /** How often the failures are fetched again, in milliseconds. */
  refreshMs?: number;
}

/**
 * The stack of failure notifications with its polling and acknowledging built in, for a host that
 * mounts it once and wants it on every page (an app-core overlay widget). orch-app wires the same two
 * parts by hand in App.tsx.
 *
 * @registryCategory composite
 * @registryTags failures notifications overlay alert
 */
export function FailureOverlay({ refreshMs }: FailureOverlayProps): React.ReactElement | null {
  const { failures, acknowledgeOne, acknowledgeAll } = useFailures(undefined, refreshMs);
  return <FailureBanner failures={failures} onAcknowledge={acknowledgeOne} onAcknowledgeAll={acknowledgeAll} />;
}
