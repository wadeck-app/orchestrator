import React, { useState, useCallback } from 'react';
import { describeMoment } from '../relative-time.js';
import { postTriggerEarly } from '../trigger-job.js';
import { getErrorMessage, type TriggerRefused } from '../types.js';

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
  /**
   * Fired once a Run early this component ran itself has settled, started or refused, so the page
   * can reload the schedule. The component posts itself because a page-owned brain sees a status,
   * never the 200 body that says the job was already running and nothing started.
   */
  onAfterRunEarly?: () => void;
}

type RunEarlyState =
  | { kind: 'pending' }
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'refused'; refusal: TriggerRefused };

// How long each outcome stays on the button. A refusal stays longest: it carries a question.
const FEEDBACK_MS = { ok: 2000, error: 3000, refused: 5000 } as const;

/*
 * Was the last of three private relative-time functions in orch-ui, and the only future-facing one.
 * `precise` exists in the shared module for this call site: without it the minutes go, and on a list
 * of upcoming firings the minutes are what is being read.
 *
 * One wording change comes with it. The old version said "now" for anything already past, which hid
 * a firing the daemon missed behind the same word it uses for one about to happen; describeMoment
 * says "overdue by 5m". That is the distinction the schedule page exists to show.
 */
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
export function ScheduleTimeline({ firings = [], onAfterRunEarly }: ScheduleTimelineProps): React.ReactElement {
  // key = `${jobId}:${ts}`
  const [btnState, setBtnState] = useState<Record<string, RunEarlyState>>({});

  const handleRunEarly = useCallback(async (jobId: string, key: string) => {
    const current = btnState[key];
    if (current?.kind === 'pending') {
      return;
    }
    // Clicking while the refusal is showing is the answer to "run anyway?".
    const force = current?.kind === 'refused';
    const settle = (next: RunEarlyState, ms: number): void => {
      setBtnState(s => ({ ...s, [key]: next }));
      setTimeout(() => setBtnState(s => { const n = { ...s }; delete n[key]; return n; }), ms);
    };
    setBtnState(s => ({ ...s, [key]: { kind: 'pending' } }));
    try {
      const refused = await postTriggerEarly(jobId, force ? { force: true } : undefined);
      if (refused) {
        settle({ kind: 'refused', refusal: refused }, FEEDBACK_MS.refused);
      } else {
        settle({ kind: 'ok' }, FEEDBACK_MS.ok);
      }
    } catch (err) {
      settle({ kind: 'error', message: getErrorMessage(err) }, FEEDBACK_MS.error);
    } finally {
      onAfterRunEarly?.();
    }
  }, [onAfterRunEarly, btnState]);

  const flat: FlatFiring[] = (firings as ScheduleEntry[]).flatMap(e =>
    (e.next ?? []).map(ts => ({ ts, label: e.label, jobId: e.jobId }))
  ).sort((a, b) => a.ts.localeCompare(b.ts));

  if (flat.length === 0) {
    return (
      <>
        <p className="text-xs text-muted mb-4">Times shown in: {OS_TZ}</p>
        <p className="text-muted text-center py-12">No upcoming cron jobs in the next 24h.</p>
      </>
    );
  }

  let lastDate = '';
  // violations-suppress-start: tailwind/no-raw-color-class run-early button feedback states use green/red which have no semantic tokens
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
              <span className="shrink-0 text-xs text-muted">{describeMoment(f.ts, Date.now(), { precise: true })}</span>
              {(() => {
                const key = `${f.jobId}:${f.ts}`;
                const st = btnState[key]?.kind;
                const state = btnState[key];
                const cls = st === 'ok'
                  ? 'shrink-0 text-xs px-2 py-0.5 rounded border border-green-600 text-green-600 cursor-default'
                  : st === 'error'
                  ? 'shrink-0 text-xs px-2 py-0.5 rounded border border-red-500 text-red-500 cursor-default'
                  : st === 'refused'
                  ? 'shrink-0 text-xs px-2 py-0.5 rounded border border-amber-500 text-amber-600 cursor-pointer'
                  : st === 'pending'
                  ? 'shrink-0 text-xs px-2 py-0.5 rounded border border-border text-muted opacity-50 cursor-wait'
                  : 'shrink-0 text-xs px-2 py-0.5 rounded border border-border text-muted hover:bg-muted-bg hover:text-content transition-colors';
                const label = state?.kind === 'refused'
                  ? `Already running (${state.refusal.running}/${state.refusal.maxConcurrency}) - run anyway?`
                  : st === 'ok' ? 'Triggered' : st === 'error' ? 'Error' : st === 'pending' ? 'Running...' : 'Run early';
                return (
                  // violations-suppress: react/no-raw-button run-early affordance is a compact inline chip inside a timeline row; Button has no variant that fits, same reason as the other chip buttons in this repo
                  <button className={cls} disabled={st === 'pending'}
                    // The error text is the only place the reason for a failed run is shown.
                    title={state?.kind === 'error' ? state.message : undefined}
                    onClick={() => handleRunEarly(f.jobId, key)}>
                    {label}
                  </button>
                );
              })()}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  // violations-suppress-end: tailwind/no-raw-color-class
  );
}
