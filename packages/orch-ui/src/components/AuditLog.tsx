// violations-suppress: ts/no-inline-subcomponent EventIcon is a pure render helper (icon selector), not a reusable subcomponent; extracting it adds no DX value
import React from 'react';
import {
  CheckCircle, XCircle, Play, Clock, Plus, Trash2,
  Pencil, ToggleLeft, ToggleRight, Power, RefreshCw,
} from 'lucide-react';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditLogProps {
  entries?: AuditEntry[];
}

// violations-suppress: ts/no-inline-subcomponent EventIcon is a pure icon selector, not a reusable component; extracting it to a separate file adds overhead without benefit
function EventIcon({ event, entry }: { event: string; entry: AuditEntry }): React.ReactElement {
  const sz = 14;
  // violations-suppress-start: tailwind/no-raw-color-class no semantic success/danger tokens for audit event icons
  if (event === 'daemon.start')     return <Power size={sz} className="text-primary" />;
  if (event === 'daemon.restart')   return <RefreshCw size={sz} className="text-primary" />;
  if (event === 'job.completed') {
    const ec = entry.exitCode as number | undefined;
    return ec === 0
      ? <CheckCircle size={sz} className="text-green-600" />
      : <XCircle size={sz} className="text-danger" />;
  }
  if (event === 'job.triggered_manual') return <Play size={sz} className="text-primary" />;
  if (event === 'job.started')     return <Clock size={sz} className="text-muted" />;
  if (event === 'job.added')       return <Plus size={sz} className="text-green-600" />;
  if (event === 'job.deleted')     return <Trash2 size={sz} className="text-danger" />;
  if (event === 'job.edited')      return <Pencil size={sz} className="text-muted" />;
  if (event === 'job.enabled')     return <ToggleRight size={sz} className="text-green-600" />;
  if (event === 'job.disabled')    return <ToggleLeft size={sz} className="text-muted" />;
  // violations-suppress-end: tailwind/no-raw-color-class
  return <Clock size={sz} className="text-muted" />;
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
 * @registryCategory composite
 * @registryTags audit log timeline events
 */
export function AuditLog({ entries = [] }: AuditLogProps): React.ReactElement {
  if (entries.length === 0) return (
    <p className="text-muted text-center py-12">No audit events yet.</p>
  );

  return (
    <div className="space-y-0.5">
      {entries.map((e, i) => (
        <div key={i} className="flex items-center py-2 rounded hover:bg-muted-bg text-sm">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <EventIcon event={e.event} entry={e} />
            <span className="font-medium text-content">{e.event}</span>
            {' '}
            <span className="text-muted truncate">{formatDetails(e)}</span>
          </div>
          <span className="shrink-0 text-xs text-muted ml-4" title={e.ts}>{relTime(e.ts)}</span>
        </div>
      ))}
    </div>
  );
}
