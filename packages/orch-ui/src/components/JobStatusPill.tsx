import React from 'react';
import { Badge } from '@wadeck-app/dsl-ui';

/** The five run outcomes this app shows. */
export type JobStatusKind = 'running' | 'ok' | 'failed' | 'cancelled' | 'never';

/**
 * Which design-system variant each outcome maps to.
 *
 * Running is info rather than warning: warning is spent on Cancelled, and a run in flight is
 * not a problem. Cancelled keeps amber, being the one outcome that asks for attention
 * without being a failure.
 */
export const JOB_STATUS_VARIANT: Record<JobStatusKind, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  running:   'info',
  ok:        'success',
  failed:    'danger',
  cancelled: 'warning',
  never:     'default',
};

/**
 * Badge for one run outcome, at the shared status weight.
 *
 * Every status renders subtle, so a column of them reads as one set. Three files used to
 * paste their own copies of a status pill's classes onto plain spans.
 *
 * Deliberately unannotated for the component registry: it is an internal building block,
 * not a DSL node type. Annotating it made the generator emit an entry that passes children,
 * which these props do not accept.
 */
export function JobStatusPill({ kind, label }: { kind: JobStatusKind; label: string }): React.ReactElement {
  return <Badge variant={JOB_STATUS_VARIANT[kind]} tone="subtle" label={label} />;
}
