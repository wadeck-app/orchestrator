import React from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { isRunActive, isRunCancelled, isRunSkipped, type RuntimeEntry } from '../types.js';
import { JobStatusBadge } from './JobStatusBadge.js';
import { TriggerBadge } from './TriggerBadge.js';

export interface RunHistoryProps {
  entries: RuntimeEntry[];
  /** Enables the per-run Logs link. Without it the run cannot be addressed, so no link is shown. */
  jobId?: string;
}

/**
 * The run's log file stamp, as RunLogger names it: colons to dashes, milliseconds dropped.
 *
 * Duplicating the rule is what makes the link land on the right run; deriving it from the displayed
 * locale string would produce a name no file has, and the pane would quietly fall back to the live
 * tail rather than say the run was not found.
 */
function runName(startedAt: string): string {
  return startedAt.replace(/:/g, '-').slice(0, 19);
}

/*
 * How long a FINISHED run took, which is a different question from how long a running one has been
 * going -- that is `formatElapsed` in relative-time.ts.
 *
 * Named apart on purpose. Both were called `formatDuration`, in four files, so the three that were
 * genuinely identical copies of the elapsed formatter and this one, which is not a copy of anything,
 * all read as the same helper. Sub-second precision matters here and nowhere else: a 40ms run and a
 * 900ms run are both "0s" to the other formatter.
 */
function formatFinishedDuration(entry: RuntimeEntry): string {
  // Liveness is finishedAt: a killed run has no exit code but did finish, and must
  // show its real duration rather than "running...".
  if (isRunActive(entry)) {
    return 'running...';
  }
  if (!entry.finishedAt) {
    return '-';
  }
  const ms = new Date(entry.finishedAt).getTime() - new Date(entry.startedAt).getTime();
  if (ms < 0) {
    return '-';
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)}s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

/**
 * @registryCategory composite
 * @registryTags history table runs
 */
export function RunHistory({ entries, jobId }: RunHistoryProps): React.ReactElement {
  if (!entries || entries.length === 0) {
    return <p className="text-sm text-muted italic">No runs yet</p>;
  }

  return (
    <table className="w-full text-sm border-collapse">
      <thead>
        <tr className="text-left text-muted border-b">
          <th className="pb-1 font-medium">Started</th>
          <th className="pb-1 font-medium">Duration</th>
          <th className="pb-1 font-medium">Peak CPU</th>
          <th className="pb-1 font-medium">Peak RAM</th>
          <th className="pb-1 font-medium">Result</th>
          <th className="pb-1 font-medium">Triggered by</th>
          <th className="pb-1 font-medium">PID</th>
          {jobId !== undefined && <th className="pb-1 font-medium">Output</th>}
        </tr>
      </thead>
      <tbody>
        {entries.map((entry, i) => {
          const date = new Date(entry.startedAt);
          // violations-suppress: ts/no-locale-date no shared formatter in orch-ui; toLocaleString acceptable here because run timestamps are display-only and test assertions use DOM presence, not text content, so locale does not affect test correctness
          const formatted = isNaN(date.getTime()) ? entry.startedAt : date.toLocaleString();
          return (
            <tr key={i}>
              <td className="py-1 pr-4 text-content">{formatted}</td>
              <td className="py-1 pr-4 text-muted">{formatFinishedDuration(entry)}</td>
              <td className="py-1 pr-4 text-muted">{entry.peakCpuPct != null ? `${entry.peakCpuPct.toFixed(1)}%` : '-'}</td>
              <td className="py-1 pr-4 text-muted">{entry.peakRamMb  != null ? `${entry.peakRamMb.toFixed(0)}MB` : '-'}</td>
              <td className="py-1 pr-4">
                {/* The badge owns the whole outcome-to-pill mapping; this cell only classifies. */}
                <JobStatusBadge
                  exitCode={entry.exitCode}
                  running={isRunActive(entry)}
                  cancelled={isRunCancelled(entry)}
                  skipped={isRunSkipped(entry)}
                />
              </td>
              <td className="py-1 pr-4"><TriggerBadge source={entry.triggeredBy} /></td>
              <td className="py-1 pr-4 text-muted">{entry.pid ?? '-'}</td>
              {jobId !== undefined && (
                <td className="py-1">
                  <Link
                    to={`/jobs/${jobId}/logs?run=${encodeURIComponent(runName(entry.startedAt))}`}
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    <FileText size={12} />
                    Logs
                  </Link>
                </td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
