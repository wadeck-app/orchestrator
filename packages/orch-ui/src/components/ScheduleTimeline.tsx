import React from 'react';

// @formatter:off
const DATE_HDR_CLS = 'text-xs font-semibold text-muted uppercase tracking-wide pt-3 pb-1 border-b border-border';
// @formatter:on

export interface ScheduleEntry {
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
  firings?: ScheduleEntry[];
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

const OS_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * @registryCategory composite
 * @registryTags schedule timeline cron firings
 */
export function ScheduleTimeline({ firings = [] }: ScheduleTimelineProps): React.ReactElement {
  const flat: FlatFiring[] = (firings as ScheduleEntry[]).flatMap(e =>
    (e.next ?? []).map(ts => ({ ts, label: e.label, jobId: e.jobId }))
  ).sort((a, b) => a.ts.localeCompare(b.ts));

  if (flat.length === 0) return (
    <>
      <p className="text-xs text-muted mb-4">Times shown in: {OS_TZ}</p>
      <p className="text-muted text-center py-12">No upcoming cron jobs in the next 24h.</p>
    </>
  );

  let lastDate = '';
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted pb-2">Times shown in: {OS_TZ}</p>
      {flat.map((f, i) => {
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
