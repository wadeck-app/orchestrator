import React from 'react';
import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { ColumnHelpers, DataTable, type TableColumn } from '@wadeck-app/dsl-ui';
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
 * One run, flattened for DataTable.
 *
 * A type alias rather than an interface: DataTable is generic over `T extends Record<string,
 * unknown>`, and only an object type literal gets the implicit index signature that satisfies it.
 *
 * The text columns are pre-formatted strings because that is what they display -- a column sorting on
 * "1.4s" would sort lexically and lie. `entry` rides along so the badge columns can classify the run
 * from the real values rather than re-parse the strings.
 */
type RunRow = {
  started: string;
  duration: string;
  peakCpu: string;
  peakRam: string;
  pid: string;
  entry: RuntimeEntry;
};

function toRow(entry: RuntimeEntry): RunRow {
  const date = new Date(entry.startedAt);
  // violations-suppress: ts/no-locale-date no shared formatter in orch-ui; toLocaleString acceptable here because run timestamps are display-only and test assertions use DOM presence, not text content, so locale does not affect test correctness
  const started = isNaN(date.getTime()) ? entry.startedAt : date.toLocaleString();
  return {
    started,
    duration: formatFinishedDuration(entry),
    peakCpu: entry.peakCpuPct != null ? `${entry.peakCpuPct.toFixed(1)}%` : '-',
    peakRam: entry.peakRamMb != null ? `${entry.peakRamMb.toFixed(0)}MB` : '-',
    pid: entry.pid != null ? String(entry.pid) : '-',
    entry,
  };
}

/**
 * @registryCategory composite
 * @registryTags history table runs
 */
export function RunHistory({ entries, jobId }: RunHistoryProps): React.ReactElement {
  const rows = (entries ?? []).map(toRow);

  const columns: TableColumn<RunRow>[] = [
    ColumnHelpers.text<RunRow>('started', 'Started'),
    ColumnHelpers.text<RunRow>('duration', 'Duration', { muted: true }),
    ColumnHelpers.text<RunRow>('peakCpu', 'Peak CPU', { muted: true }),
    ColumnHelpers.text<RunRow>('peakRam', 'Peak RAM', { muted: true }),
    {
      key: 'result',
      label: 'Result',
      // The badge owns the whole outcome-to-pill mapping; this column only classifies.
      render: ({ entry }) => (
        <JobStatusBadge
          exitCode={entry.exitCode}
          running={isRunActive(entry)}
          cancelled={isRunCancelled(entry)}
          skipped={isRunSkipped(entry)}
        />
      ),
    },
    { key: 'triggeredBy', label: 'Triggered by', render: ({ entry }) => <TriggerBadge source={entry.triggeredBy} /> },
    ColumnHelpers.text<RunRow>('pid', 'PID', { muted: true }),
  ];

  // Without a jobId a run cannot be addressed, so the column is absent rather than empty.
  if (jobId !== undefined) {
    columns.push({
      key: 'output',
      label: 'Output',
      render: ({ entry }) => (
        <Link
          to={`/jobs/${jobId}/logs?run=${encodeURIComponent(runName(entry.startedAt))}`}
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <FileText size={12} />
          Logs
        </Link>
      ),
    });
  }

  // DataTable owns the empty state now, so the early return is gone. Deliberately no `selectable` and
  // no `sortable`: a run history has nothing to act on in bulk, and every text column here holds a
  // formatted string that would sort lexically.
  return <DataTable rows={rows} columns={columns} emptyMessage="No runs yet" />;
}
