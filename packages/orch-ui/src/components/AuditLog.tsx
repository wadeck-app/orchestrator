// violations-suppress: ts/no-inline-subcomponent EventIcon is a pure render helper (icon selector), not a reusable subcomponent; extracting it adds no DX value
import React, { useState } from 'react';
import {
  CheckCircle, XCircle, Play, Clock, Plus, Trash2,
  Pencil, ToggleLeft, ToggleRight, Power, RefreshCw,
} from 'lucide-react';
import { Button } from './Button.js';

export interface AuditEntry {
  ts: string;
  event: string;
  [key: string]: unknown;
}

export interface AuditLogProps {
  entries?: AuditEntry[];
}

const PAGE_SIZE = 20;

const EVENT_FILTERS = [
  'All',
  'job.completed',
  'job.started',
  'job.triggered_manual',
  'job.added',
  'job.deleted',
  'job.edited',
  'job.enabled',
  'job.disabled',
  'daemon.start',
  'daemon.restart',
] as const;

// @formatter:off
const CHIP_ACTIVE   = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary text-on-primary';
const CHIP_INACTIVE = 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-muted-bg text-muted border border-border hover:bg-border';
// @formatter:on

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

function entryMatchesSearch(entry: AuditEntry, q: string): boolean {
  if (!q) return true;
  const lower = q.toLowerCase();
  if (entry.event.toLowerCase().includes(lower)) return true;
  for (const v of Object.values(entry)) {
    if (typeof v === 'string' && v.toLowerCase().includes(lower)) return true;
  }
  return false;
}

/**
 * @registryCategory composite
 * @registryTags audit log timeline events
 */
export function AuditLog({ entries = [] }: AuditLogProps): React.ReactElement {
  const [search, setSearch]       = useState('');
  const [eventFilter, setFilter]  = useState<string>('All');
  const [page, setPage]           = useState(1);

  const filtered = entries.filter(e =>
    (eventFilter === 'All' || e.event === eventFilter) &&
    entryMatchesSearch(e, search)
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const resetPage = () => setPage(1);

  return (
    <div>
      {/* Search + event filter */}
      <div className="mb-3 flex flex-col gap-2">
        {/* violations-suppress: react/no-raw-input search bar - FieldText requires a label prop; this is a labelless search input */}
        <input
          type="text"
          placeholder="Search events..."
          value={search}
          onChange={e => { setSearch(e.target.value); resetPage(); }}
          className="w-full border border-border rounded-md px-3 py-1.5 text-sm bg-surface text-content focus:outline-none focus:ring-2 focus:ring-primary"
        />
        <div className="flex flex-wrap gap-1">
          {EVENT_FILTERS.map(f => (
            // violations-suppress: react/no-raw-button filter chip - active/inactive state not supported by Button
            <button
              key={f}
              onClick={() => { setFilter(f); resetPage(); }}
              className={eventFilter === f ? CHIP_ACTIVE : CHIP_INACTIVE}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {paged.length === 0 ? (
        <p className="text-muted text-center py-12">No audit events match.</p>
      ) : (
        <div className="space-y-0.5">
          {paged.map((e, i) => (
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
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <Button label="Previous" variant="secondary" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)} />
          <span className="text-sm text-muted">Page {safePage} of {totalPages}</span>
          <Button label="Next" variant="secondary" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)} />
        </div>
      )}
    </div>
  );
}
