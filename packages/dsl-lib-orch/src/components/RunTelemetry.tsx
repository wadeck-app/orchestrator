import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../types.js';
import { getApiBase } from '../runtime-config.js';
import { RunTelemetryChart, type RunTelemetryData } from './RunTelemetryChart.js';

/** A run in progress is re-read this often. Samples are taken every 2 s; slower than that keeps the load on the daemon small. */
export const TELEMETRY_POLL_MS = 5000;

export interface RunTelemetryProps {
  jobId: string;
  /** The run's startedAt. Without it the daemon answers the newest run it has telemetry for. */
  run?: string;
  /**
   * Whether the run is still going, when the caller knows (a run history does). Without it the answer
   * decides: a run with samples and no end is taken as going.
   */
  running?: boolean;
}

/** The server answered, with a refusal worded for the reader (as opposed to not answering at all). */
class TelemetryRefusal extends Error {}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: RunTelemetryData; refreshError?: string }
  | { state: 'error'; message: string };

/** What failed and what to try, from the HTTP answer. */
async function failureMessage(res: Response): Promise<string> {
  if (res.status === 503) {
    return 'The orchestrator daemon is not running, so the telemetry cannot be read. Start it with "orch start", then reload this page.';
  }
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // Not JSON: the status line alone will do.
  }
  return `The server answered HTTP ${res.status}${detail ? ` (${detail})` : ''} when asked for the telemetry. Check "orch logs" for the daemon's side, then reload.`;
}

/**
 * CPU and RAM of one run over time, with the soft and hard budgets it was held to, the moment the monitor
 * killed it and how it ended. A run in progress is re-read every 5 s; a finished one is read once.
 *
 * @registryCategory composite
 * @registryTags telemetry chart cpu ram run
 */
export function RunTelemetry({ jobId, run, running }: RunTelemetryProps): React.ReactElement {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [live, setLive] = useState(running ?? false);
  const generation = useRef(0);

  const fetchOnce = useCallback(async (isRefresh: boolean): Promise<void> => {
    const mine = ++generation.current;
    const query = run !== undefined ? `?run=${encodeURIComponent(run)}` : '';
    try {
      const res = await fetch(`${getApiBase()}/api/jobs/${encodeURIComponent(jobId)}/telemetry${query}`);
      if (!res.ok) {
        throw new TelemetryRefusal(await failureMessage(res));
      }
      const data = (await res.json()) as RunTelemetryData;
      if (mine === generation.current) {
        setLoad({ state: 'ready', data });
        // The caller knowing beats the answer: a run history knows a run is going before its first sample.
        setLive(running ?? (data.available && data.end === undefined));
      }
    } catch (err) {
      if (mine !== generation.current) {
        return;
      }
      const message = err instanceof TelemetryRefusal
        ? getErrorMessage(err)
        : `Could not reach the dashboard server (${getErrorMessage(err)}). Check that it is running, then reload this page.`;
      setLoad(prev => (isRefresh && prev.state === 'ready' ? { ...prev, refreshError: message } : { state: 'error', message }));
    }
  }, [jobId, run, running]);

  useEffect(() => {
    setLoad({ state: 'loading' });
    void fetchOnce(false);
    return () => { generation.current++; };
  }, [fetchOnce]);

  useEffect(() => {
    if (!live) {
      return undefined;
    }
    const timer = setInterval(() => { void fetchOnce(true); }, TELEMETRY_POLL_MS);
    return () => clearInterval(timer);
  }, [live, fetchOnce]);

  if (load.state === 'loading') {
    return <p className="text-sm text-muted" role="status">Loading telemetry...</p>;
  }
  if (load.state === 'error') {
    return <p className="text-sm text-danger" role="alert">{load.message}</p>;
  }
  const { data } = load;
  if (!data.available) {
    return (
      <div className="text-sm text-muted" role="status">
        <p>No CPU and RAM chart for this run: {data.reason ?? 'the daemon gave no reason.'}</p>
        <p>Telemetry is kept only for the most recent samples of each job (about 4 MiB), so the chart of an old run is gone.</p>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <RunTelemetryChart data={data} />
      <p className="text-xs text-muted">
        {data.bucketSeconds !== null
          ? `${data.rawSamples} samples shown as ${data.samples.length} points of ${data.bucketSeconds}s each, every point being the highest reading of its ${data.bucketSeconds}s. `
          : ''}
        {data.truncated ? 'The start of this run was rotated out of the telemetry file: the chart begins late. ' : ''}
        {data.soft === null && data.hard === null ? 'No budget lines: this run started before the job had enough measured runs for a baseline. ' : ''}
        {load.refreshError ? `The last refresh failed, this is the previous reading. ${load.refreshError}` : ''}
      </p>
    </div>
  );
}
