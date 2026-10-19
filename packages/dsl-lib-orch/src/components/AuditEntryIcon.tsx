import React from 'react';
import {
  CheckCircle, XCircle, Play, Clock, Plus, Trash2,
  Pencil, ToggleLeft, ToggleRight, Power, RefreshCw, Square,
  SkipForward, Ban, AlertTriangle,
} from 'lucide-react';
import type { AuditEntry } from './AuditEntryRow.js';

export interface AuditEntryIconProps {
  event: string;
  entry: AuditEntry;
}

/**
 * @registryCategory atomic
 * @registryTags audit icon event
 */
// violations-suppress-start: tailwind/no-raw-color-class no semantic success/danger tokens for audit event icons
export function AuditEntryIcon({ event, entry }: AuditEntryIconProps): React.ReactElement {
  const sz = 14;
  if (event === 'daemon.start')          {
    return <Power size={sz} className="text-primary" />;
  }
  if (event === 'daemon.restart')        {
    return <RefreshCw size={sz} className="text-primary" />;
  }
  if (event === 'job.completed') {
    // A run flagged skipped keeps the child's real exit code and is not a failure (same rule as the daemon).
    if (entry.skipped === true) {
      return <SkipForward size={sz} className="text-muted" />;
    }
    const ec = entry.exitCode as number | undefined;
    return ec === 0
      ? <CheckCircle size={sz} className="text-green-600" />
      : <XCircle size={sz} className="text-danger" />;
  }
  // Nothing was started: the job's own exit-code skip, or a firing refused (concurrency, adopted, liveness).
  // Neutral on purpose, it asks for nothing.
  if (event === 'job.skipped') {
    return <SkipForward size={sz} className="text-muted" />;
  }
  // A manual trigger the daemon turned down (job at its concurrency limit): somebody asked, nothing ran.
  if (event === 'job.trigger_refused') {
    return <Ban size={sz} className="text-warning" />;
  }
  // The daemon died with runs open and closed them at the next start: worth a look, not the job's fault.
  if (event === 'runs.orphaned_closed') {
    return <AlertTriangle size={sz} className="text-warning" />;
  }
  if (event === 'job.triggered_manual') {
    return <Play size={sz} className="text-primary" />;
  }
  if (event === 'job.killed_manual')    {
    return <Square size={sz} className="text-warning" />;
  }
  if (event === 'job.started')          {
    return <Clock size={sz} className="text-muted" />;
  }
  if (event === 'job.added')            {
    return <Plus size={sz} className="text-green-600" />;
  }
  if (event === 'job.deleted')          {
    return <Trash2 size={sz} className="text-danger" />;
  }
  if (event === 'job.edited')           {
    return <Pencil size={sz} className="text-muted" />;
  }
  if (event === 'job.enabled')          {
    return <ToggleRight size={sz} className="text-green-600" />;
  }
  if (event === 'job.disabled')         {
    return <ToggleLeft size={sz} className="text-muted" />;
  }
  return <Clock size={sz} className="text-muted" />;
}
// violations-suppress-end: tailwind/no-raw-color-class
