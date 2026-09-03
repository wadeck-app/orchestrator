import React, { useEffect, useState } from 'react';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditLogProps {
  apiBase?: string;
}

// @formatter:off
const EVENT_ICONS: Record<string, string> = {
  'job.triggered_manual': '▶',
  'job.completed':        '✓',
  'job.added':            '+',
  'job.deleted':          '×',
  'job.enabled':          '●',
  'job.disabled':         '○',
  'job.edited':           '✎',
  'daemon.start':         '↑',
  'daemon.restart':       '↻',
};
// @formatter:on

function eventColor(event: string): string {
  if (event === 'job.completed') return 'text-green-600';
  if (event.includes('delete') || event.includes('fail')) return 'text-danger';
  if (event === 'daemon.restart' || event === 'daemon.start') return 'text-primary';
  return 'text-muted';
}

function formatDetails(entry: AuditEntry): string {
  const skip = new Set(['ts', 'event', 'label', 'jobId', 'userAgent']);
  const parts: string[] = [];
  if (entry.label) parts.push(String(entry.label));
  else if (entry.jobId) parts.push(String(entry.jobId));
  for (const [k, v] of Object.entries(entry)) {
    if (skip.has(k) || v === undefined || v === null) continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(' · ');
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
export function AuditLog({ apiBase = '' }: AuditLogProps): React.ReactElement {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${apiBase}/api/audit?limit=100`)
      .then(r => r.json())
      .then((data: AuditEntry[]) => { setEntries(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [apiBase]);

  if (loading) return (
    <div className="flex justify-center py-12">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (entries.length === 0) return (
    <p className="text-muted text-center py-12">No audit events yet.</p>
  );

  return (
    <div className="space-y-1">
      {entries.map((e, i) => (
        <div key={i} className="flex items-start gap-3 px-3 py-2 rounded hover:bg-muted-bg text-sm">
          {/* violations-suppress: tailwind/no-raw-color-class event status colors need per-event semantics with no design-system equivalent */}
          <span className={`shrink-0 w-5 text-center font-mono ${eventColor(e.event)}`}>
            {EVENT_ICONS[e.event] ?? '·'}
          </span>
          <div className="flex-1 min-w-0">
            <span className="font-medium text-content">{e.event}</span>
            {' '}
            <span className="text-muted truncate">{formatDetails(e)}</span>
          </div>
          <span className="shrink-0 text-xs text-muted" title={e.ts}>{relTime(e.ts)}</span>
        </div>
      ))}
    </div>
  );
}
