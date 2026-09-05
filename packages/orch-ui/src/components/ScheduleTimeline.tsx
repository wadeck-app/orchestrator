import React, { useEffect, useState } from 'react';

// @formatter:off
const DATE_HDR_CLS = 'text-xs font-semibold text-muted uppercase tracking-wide pt-3 pb-1 border-b border-border';
// @formatter:on

interface ScheduleEntry {
  jobId: string;
  label: string;
  next: string[];
}

interface FlatFiring {
  ts: string;
  label: string;
  jobId: string;
}

export interface ScheduleTimelineProps {
  apiBase?: string;
}

function relTime(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  // violations-suppress: ts/no-locale-date display-only time formatting, locale acceptable
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  // violations-suppress: ts/no-locale-date display-only date formatting, locale acceptable
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/**
 * @registryCategory composite
 * @registryTags schedule timeline cron firings
 */
export function ScheduleTimeline({ apiBase = '' }: ScheduleTimelineProps): React.ReactElement {
  const [firings, setFirings] = useState<FlatFiring[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${apiBase}/api/schedule`)
      .then(r => r.json())
      .then((data: ScheduleEntry[]) => {
        const flat: FlatFiring[] = data.flatMap(e =>
          e.next.map(ts => ({ ts, label: e.label, jobId: e.jobId }))
        );
        flat.sort((a, b) => a.ts.localeCompare(b.ts));
        setFirings(flat);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [apiBase]);

  if (loading) return (
    <div className="flex justify-center py-12">
      <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
    </div>
  );

  if (firings.length === 0) return (
    <p className="text-muted text-center py-12">No upcoming cron jobs in the next 24h.</p>
  );

  let lastDate = '';
  return (
    <div className="space-y-1">
      {firings.map((f, i) => {
        const date = fmtDate(f.ts);
        const showDate = date !== lastDate;
        lastDate = date;
        return (
          <React.Fragment key={i}>
            {showDate && (
              <p className={DATE_HDR_CLS}>
                {date}
              </p>
            )}
            <div className="flex items-center gap-3 px-2 py-1.5 rounded hover:bg-muted-bg text-sm">
              <span className="shrink-0 font-mono text-xs text-muted w-12">{fmtTime(f.ts)}</span>
              <span className="flex-1 text-content truncate">{f.label}</span>
              <span className="shrink-0 text-xs text-muted">{relTime(f.ts)}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
