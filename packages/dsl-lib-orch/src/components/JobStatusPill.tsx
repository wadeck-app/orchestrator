import React from 'react';
import { Badge } from '@wadeck-app/dsl-ui';
import type { RunEndReason } from '../types.js';

/**
 * The states this app shows for a job in a list.
 *
 * Six are run outcomes. `pending` is not: it describes the job rather than a run, for a cron job whose
 * active window has not opened yet. That job is enabled and correctly doing nothing, and it used to
 * show "Never run" -- true, and indistinguishable from a job that is broken.
 */
export type JobStatusKind = 'running' | 'ok' | 'failed' | 'cancelled' | 'skipped' | 'never' | 'pending' | 'interrupted'
  | 'timed-out' | 'killed' | 'resource-killed';

/**
 * Which design-system variant each state maps to.
 *
 * Running is info rather than warning: warning is spent on Cancelled, and a run in flight is
 * not a problem. Cancelled keeps amber, being the one outcome that asks for attention
 * without being a failure. Skipped is neutral by design: the run asks for nothing, so it must
 * not borrow danger's red nor success's green.
 *
 * Pending is neutral for the same reason, and deliberately not `info`: info is Running, and a job
 * waiting for Monday must not look like one executing now. Neutral is the honest reading -- nothing is
 * wrong and nothing is happening -- with the label carrying the difference from `never`.
 */
export const JOB_STATUS_VARIANT: Record<JobStatusKind, 'success' | 'danger' | 'warning' | 'info' | 'default'> = {
  running:   'info',
  ok:        'success',
  failed:    'danger',
  cancelled: 'warning',
  skipped:   'default',
  never:     'default',
  // Amber like Cancelled: it asks for a glance (the daemon died mid-run) without being the job's fault.
  interrupted: 'warning',
  pending:   'default',
  // The three forced ends, one tone each. A timeout is the job's own overrun and is counted as a failure, so red.
  // A resource-limit kill is the daemon stepping in: amber, a glance. A kill by the user asked for nothing: neutral.
  'timed-out':       'danger',
  'resource-killed': 'warning',
  killed:            'default',
};

/** The pill for a forced end: one wording per reason, so the three are never folded back into "Cancelled". */
export const END_REASON_PILL: Record<RunEndReason, { kind: JobStatusKind; label: string }> = {
  'timeout':        { kind: 'timed-out', label: 'Timed out' },
  'manual-kill':    { kind: 'killed', label: 'Killed by you' },
  'resource-limit': { kind: 'resource-killed', label: 'Killed: resource limit' },
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
