import React, { useEffect, useState } from 'react';
import { ChipButton } from '@wadeck-app/dsl-ui';
import { getErrorMessage, type ResourceHistory as ResourceHistoryData } from '../types.js';
import { getApiBase } from '../runtime-config.js';
import { ResourceHistoryChart } from './ResourceHistoryChart.js';

export interface ResourceHistoryProps {
  jobId: string;
}

/** The ranges offered: the newest N runs, or every run the daemon keeps. */
const RANGES = [
  { id: '20', label: 'Last 20', count: 20 },
  { id: '50', label: 'Last 50', count: 50 },
  { id: '100', label: 'Last 100', count: 100 },
  { id: 'all', label: 'All retained', count: Infinity },
] as const;
type RangeId = (typeof RANGES)[number]['id'];

/** What the first request asks for; only "all retained" asks for the daemon maximum. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** The server answered, with a refusal worded for the reader (as opposed to not answering at all). */
class HistoryRefusal extends Error {}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: ResourceHistoryData }
  | { state: 'error'; message: string };

/** What failed and what to try, from the HTTP answer. */
async function failureMessage(res: Response, jobId: string): Promise<string> {
  if (res.status === 503) {
    return 'The orchestrator daemon is not running, so the resource history cannot be read. Start it with "orch start", then reload this page.';
  }
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // Not JSON: the status line alone will do.
  }
  if (res.status === 404) {
    return `There is no job "${jobId}" to read a resource history for${detail ? ` (${detail})` : ''}. It may have been removed: go back to the jobs list.`;
  }
  return `The server answered HTTP ${res.status}${detail ? ` (${detail})` : ''} when asked for the resource history. Check "orch logs" for the daemon's side, then reload.`;
}

function isHistory(value: unknown): value is ResourceHistoryData {
  const v = value as Partial<ResourceHistoryData> | null;
  return typeof v === 'object' && v !== null && Array.isArray(v.runs) && typeof v.total === 'number' && typeof v.retention === 'number';
}

/**
 * Peak and average CPU and RAM of a job's last runs, one mark per run from the oldest to the newest, with the
 * limits each run was held to and the runs the monitor ended in red. Read once per range, not polled.
 *
 * @registryCategory composite
 * @registryTags resource history chart cpu ram runs
 */
export function ResourceHistory({ jobId }: ResourceHistoryProps): React.ReactElement {
  const [range, setRange] = useState<RangeId>('100');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  // A bigger window needs a bigger request; a smaller one is cut from what is already there.
  const limit = range === 'all' ? MAX_LIMIT : DEFAULT_LIMIT;

  useEffect(() => {
    let current = true;
    setLoad({ state: 'loading' });
    (async () => {
      try {
        const res = await fetch(`${getApiBase()}/api/jobs/${encodeURIComponent(jobId)}/resource-history?limit=${limit}`);
        if (!res.ok) {
          throw new HistoryRefusal(await failureMessage(res, jobId));
        }
        const data: unknown = await res.json();
        if (!isHistory(data)) {
          throw new HistoryRefusal('The server gave an unexpected answer for the resource history (no list of runs). The dashboard and the daemon are probably on different versions: run "orch cli update", then reload this page.');
        }
        if (current) {
          setLoad({ state: 'ready', data });
        }
      } catch (err) {
        if (current) {
          setLoad({
            state: 'error',
            message: err instanceof HistoryRefusal
              ? getErrorMessage(err)
              : `Could not reach the dashboard server (${getErrorMessage(err)}). Check that it is running, then reload this page.`,
          });
        }
      }
    })();
    return () => { current = false; };
  }, [jobId, limit]);

  if (load.state === 'loading') {
    return <p className="text-sm text-muted" role="status">Loading resource history...</p>;
  }
  if (load.state === 'error') {
    return <p className="text-sm text-danger" role="alert">{load.message}</p>;
  }
  const { data } = load;
  if (data.runs.length === 0) {
    return (
      <p className="text-sm text-muted" role="status">
        No run measured yet. CPU and RAM are measured while the job runs: the history appears after its next run.
      </p>
    );
  }
  const count = RANGES.find(r => r.id === range)!.count;
  // The daemon answers newest first; the chart reads oldest to newest.
  const shown = data.runs.slice(0, count).reverse();
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Number of runs shown">
        {RANGES.map(r => (
          <ChipButton key={r.id} active={r.id === range} aria-pressed={r.id === range} onClick={() => setRange(r.id)}>
            {r.label}
          </ChipButton>
        ))}
      </div>
      <ResourceHistoryChart runs={shown} />
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-label="Legend">
        <li><span className="text-primary">&#9632;</span> Peak</li>
        <li><span className="text-content">&#9473;</span> Average</li>
        <li><span className="text-warning">&#9473; &#9473;</span> soft limit</li>
        <li><span className="text-danger">&#9473; &#9473;</span> hard limit</li>
        <li><span className="text-danger">&#9632;</span> ended by the resource limit</li>
        <li><span className="text-muted">&#9632;</span> timeout or manual kill</li>
      </ul>
      <p className="text-xs text-muted">
        {shown.length} of {data.total} runs shown. The daemon keeps the last {data.retention} runs of each job.
        {' '}A line is missing where a run had no limit yet (the job had too few measured runs for a baseline).
      </p>
    </div>
  );
}
