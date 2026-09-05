import React from 'react';
import { AuditEntryIcon } from './AuditEntryIcon.js';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditEntryRowProps {
  entry: AuditEntry;
}

function formatDetails(entry: AuditEntry): string {
  const skip = new Set(['ts', 'event', 'label', 'jobId', 'userAgent']);
  const parts: string[] = [];
  if (entry.label) parts.push(String(entry.label));
  else if (entry.jobId) parts.push(String(entry.jobId));

  if (entry.event === 'job.completed' && entry.exitCode !== undefined) {
    parts.push(`exit ${entry.exitCode}`);
    if (entry.finishedAt && entry.startedAt) {
      const ms = new Date(entry.finishedAt as string).getTime() - new Date(entry.startedAt as string).getTime();
      if (ms >= 0) {
        const s = ms / 1000;
        parts.push(s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`);
      }
    }
  }
  if (entry.event === 'job.triggered_manual' && entry.ip) {
    parts.push(`from ${entry.ip}`);
  }
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k) || ['exitCode', 'finishedAt', 'startedAt', 'ip'].includes(k)) continue;
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(' | ');
}

function relTime(iso: string): string {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/**
 * @registryCategory atomic
 * @registryTags audit row entry
 */
export function AuditEntryRow({ entry }: AuditEntryRowProps): React.ReactElement {
  return (
    <div className="flex items-center py-2 rounded hover:bg-muted-bg text-sm">
      <div className="flex-1 min-w-0 flex items-center gap-2">
        <AuditEntryIcon event={entry.event} entry={entry} />
        <span className="font-medium text-content">{entry.event}</span>
        {' '}
        <span className="text-muted truncate">{formatDetails(entry)}</span>
      </div>
      <span className="shrink-0 text-xs text-muted ml-4" title={entry.ts}>{relTime(entry.ts)}</span>
    </div>
  );
}
