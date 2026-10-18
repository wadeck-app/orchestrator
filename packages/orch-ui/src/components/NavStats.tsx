import React, { useEffect, useState } from 'react';
import { getApiBase } from '../runtime-config.js';
import { isJobRunning, isRunFailed, latestRun, type Job, type RuntimeEntry } from '../types.js';

interface StatsData { total: number; running: number; failed: number; }

const DEFAULT_REFRESH_MS = 30_000;

export interface NavStatsProps {
  /** How often the figures are refreshed, in milliseconds. */
  refreshMs?: number;
}

/**
 * The "8 jobs / 1 running / 1 failed" figures of the navbar, on their own so a host other than orch-app
 * (an app-core module putting them in app-core's navbar) can show them. NavBar renders this same
 * component. Renders nothing until the daemon has answered once, and keeps the last figures when it stops
 * answering: a wrong figure is worse than a stale one, and a blank is the honest default.
 *
 * @registryCategory composite
 * @registryTags navbar stats jobs status
 */
export function NavStats({ refreshMs = DEFAULT_REFRESH_MS }: NavStatsProps): React.ReactElement | null {
  const [stats, setStats] = useState<StatsData | null>(null);

  useEffect(() => {
    const load = (): void => {
      fetch(`${getApiBase()}/api/jobs`).then(r => r.json()).then((all: { job: Job; runHistory: RuntimeEntry[] }[]) => {
        /*
         * Spent `once` jobs are dropped first, because this counter has to agree with the job grid
         * beside it: with four cron jobs listed and four already-fired once jobs hidden, "8 jobs"
         * contradicts what the user can count on screen and reads as jobs missing from the grid.
         *
         * It also keeps the failure badge from being held open for good by a one-off job whose single
         * run failed - there is no next run that could ever clear it.
         */
        const items   = all.filter(i => !(i.job.type === 'once' && i.job.spent === true));
        const total   = items.length;
        // Jobs with any open run: a job whose newest run ended may still have an older instance alive.
        const running = items.filter(i => isJobRunning(i.runHistory)).length;
        // Shares the one classifier rather than re-deriving it from exitCode, which is how this
        // counter came to include skipped runs in the global failure badge.
        const failed  = items.filter(i => isRunFailed(latestRun(i.runHistory))).length;
        setStats({ total, running, failed });
      }).catch(() => { /* daemon may be unavailable */ });
    };
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [refreshMs]);

  if (stats === null) {
    return null;
  }
  return (
    <div className="hidden sm:flex items-center gap-2 text-xs text-muted mr-3">
      <span>{stats.total} jobs</span>
      {stats.running > 0 && <span className="text-primary">{stats.running} running</span>}
      {stats.failed > 0  && <span className="text-danger">{stats.failed} failed</span>}
      {stats.running === 0 && stats.failed === 0 && <span className="text-success">All OK</span>}
    </div>
  );
}
