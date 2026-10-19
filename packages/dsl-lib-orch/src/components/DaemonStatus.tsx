import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getErrorMessage } from '../types.js';
import { getApiBase } from '../runtime-config.js';
import { JobLink } from './JobLink.js';
import { describeAgo } from '../relative-time.js';

/** The daemon status is re-read this often. */
export const DAEMON_STATUS_REFRESH_MS = 30_000;

/**
 * What GET /api/daemon answers (the daemon's get-daemon-info). Duplicated here on purpose, like the other
 * domain types of this package: dsl-lib-orch has no dependency on orchestrator-cli.
 */
export interface DaemonInfo {
  version: string;
  pid: number;
  port: number;
  startedAt: string;
  uptimeSeconds: number;
  config: {
    supervisedJobs: boolean;
    lateActionWindowMinutes: number;
    autoUpdate: boolean;
    appCore: boolean;
    catchUpInitialDelaySeconds: number;
    catchUpStaggerSeconds: number;
  };
  supervisor: { requested: boolean; active: boolean; note?: string };
  runs: { running: number; supervised: number; followedAgain: number };
  scheduler: { armed: number; desired: number; problems: Array<{ jobId: string; problem: string }> };
}

export interface DaemonStatusProps {
  /** How often the status is read again, in milliseconds (default 30 s). */
  refreshMs?: number;
}

const STARTED_AT_FORMAT = new Intl.DateTimeFormat([], { dateStyle: 'medium', timeStyle: 'short' });

/** The server answered, with a refusal worded for the reader (as opposed to not answering at all). */
class DaemonStatusRefusal extends Error {}

type Load =
  | { state: 'loading' }
  | { state: 'ready'; info: DaemonInfo; refreshError?: string }
  | { state: 'error'; message: string };

/** What failed and what to try, from the HTTP answer. */
async function failureMessage(res: Response): Promise<string> {
  if (res.status === 503) {
    return 'The orchestrator daemon is not running, so its status cannot be read. Start it with "orch start", then reload this page.';
  }
  let detail = '';
  try {
    detail = ((await res.json()) as { error?: string }).error ?? '';
  } catch {
    // Not JSON: the status line alone will do.
  }
  return `The server answered HTTP ${res.status}${detail ? ` (${detail})` : ''} when asked for the daemon status. Check "orch logs" for the daemon's side, then reload.`;
}

// A render helper, not a component: one component per file.
function supervisorLines(info: DaemonInfo): React.ReactElement {
  const { supervisor, config } = info;
  if (supervisor.active) {
    const minutes = config.lateActionWindowMinutes;
    return (
      <div>
        <p className="text-success">Jobs run under a supervisor: they keep running while the daemon restarts or updates.</p>
        <p className="text-muted text-xs">
          {minutes === 0
            ? 'A run that ended while the daemon was down never retries (late-action window: 0).'
            : `A run that ended while the daemon was down still retries if it ended less than ${minutes} min before it came back.`}
        </p>
      </div>
    );
  }
  if (supervisor.requested) {
    return (
      <div role="alert" className="text-warning">
        <p>Jobs run without a supervisor: a daemon restart will stop them.</p>
        {supervisor.note !== undefined && <p className="text-xs">{supervisor.note}</p>}
      </div>
    );
  }
  return <p className="text-muted">Supervisor: off (supervisedJobs: false in config.yml). A daemon restart stops running jobs.</p>;
}

// A render helper, not a component: one component per file.
function schedulerLines(info: DaemonInfo): React.ReactElement {
  const { armed, desired, problems } = info.scheduler;
  if (problems.length === 0 && armed === desired) {
    return <p className="text-success">{`All ${desired} timers armed.`}</p>;
  }
  return (
    <div className="text-warning">
      <p>{`${armed} of ${desired} timers armed.`}</p>
      {problems.length > 0 && (
        <ul className="text-xs list-disc pl-4">
          {problems.map(p => (
            <li key={p.jobId}><JobLink jobId={p.jobId} />: <span>{p.problem}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The daemon itself on one card: its version and since when it is up, whether jobs run under a supervisor
 * (and what the late-action window means), the runs going now, and whether every timer is armed. Read every
 * 30 s; a failed refresh keeps the last answer and says so.
 *
 * @registryCategory composite
 * @registryTags daemon status supervisor version scheduler timers
 */
export function DaemonStatus({ refreshMs = DAEMON_STATUS_REFRESH_MS }: DaemonStatusProps): React.ReactElement {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const generation = useRef(0);

  const fetchOnce = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    try {
      const res = await fetch(`${getApiBase()}/api/daemon`);
      if (!res.ok) {
        throw new DaemonStatusRefusal(await failureMessage(res));
      }
      const info = (await res.json()) as DaemonInfo;
      if (mine === generation.current) {
        setLoad({ state: 'ready', info });
      }
    } catch (err) {
      if (mine !== generation.current) {
        return;
      }
      const message = err instanceof DaemonStatusRefusal
        ? getErrorMessage(err)
        : `Could not reach the dashboard server (${getErrorMessage(err)}). Check that it is running, then reload this page.`;
      setLoad(prev => (prev.state === 'ready' ? { ...prev, refreshError: message } : { state: 'error', message }));
    }
  }, []);

  useEffect(() => {
    void fetchOnce();
    const timer = setInterval(() => { void fetchOnce(); }, refreshMs);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [fetchOnce, refreshMs]);

  const box = 'rounded-lg border border-border bg-surface p-3 text-sm space-y-2';
  if (load.state === 'loading') {
    return <div className={box}><p className="text-muted">Reading the daemon status...</p></div>;
  }
  if (load.state === 'error') {
    return <div className={box} role="alert"><p className="text-danger">{load.message}</p></div>;
  }

  const { info } = load;
  const now = Date.now();
  return (
    <div className={box}>
      <div>
        <p className="font-medium">{`Daemon v${info.version}`}</p>
        <p className="text-muted text-xs">
          {`Up since ${STARTED_AT_FORMAT.format(new Date(info.startedAt))} (${describeAgo(info.startedAt, now)})`}
        </p>
      </div>
      {supervisorLines(info)}
      <p>
        <span>{`${info.runs.running} running`}</span>
        <span className="text-muted">{`, ${info.runs.supervised} supervised, ${info.runs.followedAgain} followed again after the last start`}</span>
      </p>
      {schedulerLines(info)}
      {load.refreshError !== undefined && (
        <p className="text-warning text-xs">{`The status could not be refreshed: ${load.refreshError}`}</p>
      )}
    </div>
  );
}
