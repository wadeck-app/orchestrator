import React from 'react';
import { AuditEntryIcon } from './AuditEntryIcon.js';
import { describeAgo } from '../relative-time.js';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditEntryRowProps {
  entry: AuditEntry;
}

function formatSeconds(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/**
 * How long the run took. The daemon writes `durationMs` (audit-wiring.ts); startedAt/finishedAt are
 * what older entries carried and are still read when that is all there is. Null when neither says.
 */
function durationOf(entry: AuditEntry): number | null {
  if (typeof entry.durationMs === 'number') {
    return entry.durationMs;
  }
  if (entry.finishedAt && entry.startedAt) {
    const ms = new Date(entry.finishedAt as string).getTime() - new Date(entry.startedAt as string).getTime();
    return ms >= 0 ? ms : null;
  }
  return null;
}

// Fields rendered as words by formatDetails; the rest of the entry falls through as key=value.
const RENDERED_FIELDS = new Set([
  'ts', 'event', 'label', 'jobId', 'userAgent',
  'exitCode', 'finishedAt', 'startedAt', 'durationMs', 'trigger', 'reason', 'late', 'ip',
]);

function formatDetails(entry: AuditEntry): string {
  const parts: string[] = [];
  if (entry.label) {
    parts.push(String(entry.label));
  }
  else if (entry.jobId) {
    parts.push(String(entry.jobId));
  }

  // null is a run that never produced a code (nothing spawned, or killed): nothing to print.
  if ((entry.event === 'job.completed' || entry.event === 'job.skipped') && typeof entry.exitCode === 'number') {
    parts.push(`exit ${entry.exitCode}`);
  }
  const ms = durationOf(entry);
  // A refusal has a duration of 0 by construction (nothing ran): "0.0s" would suggest a run that took no time.
  if (ms !== null && !(ms === 0 && entry.event === 'job.skipped')) {
    parts.push(formatSeconds(ms));
  }
  if (entry.trigger) {
    parts.push(String(entry.trigger));
  }
  if (entry.reason) {
    parts.push(String(entry.reason));
  }
  // The entry's time is when the daemon noticed; the run itself ended earlier, while the daemon was down.
  if (entry.late === true) {
    parts.push('late');
  }
  if (entry.ip) {
    parts.push(`from ${entry.ip}`);
  }
  for (const [k, v] of Object.entries(entry)) {
    if (RENDERED_FIELDS.has(k) || v === undefined || v === null) {
      continue;
    }
    parts.push(`${k}=${v}`);
  }
  return parts.join(' | ');
}

// Was a private copy of "how long ago", one of three in dsl-lib-orch with three different wordings.
// describeAgo is the shared one; it differs only below two minutes, where it keeps saying seconds
// ("90s ago") instead of rounding to "1m ago".

/**
 * @registryCategory atomic
 * @registryTags audit row entry
 */
export function AuditEntryRow({ entry }: AuditEntryRowProps): React.ReactElement {
  return (
    // `-mx-2 px-2` rather than plain `px-2`: the highlight needs to extend past the text on both
    // sides, but the text itself must stay where it was. With padding alone the whole list would
    // shift inwards; the negative margin gives the row the extra width instead of taking it from
    // the content. Without either, the hover surface stopped exactly at the icon and the
    // timestamp, which read as clipped rather than selected.
    <div className="flex items-center -mx-2 px-2 py-2 rounded hover:bg-muted-bg text-sm">
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <AuditEntryIcon event={entry.event} entry={entry} />
        <span className="font-medium text-content">{entry.event}</span>
        {' '}
        <span className="text-muted truncate">{formatDetails(entry)}</span>
      </div>
      <span className="shrink-0 text-xs text-muted ml-4" title={entry.ts}>{describeAgo(entry.ts, Date.now())}</span>
    </div>
  );
}
