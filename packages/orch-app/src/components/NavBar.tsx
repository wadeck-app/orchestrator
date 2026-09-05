import React, { useCallback, useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Layers, LayoutGrid, Calendar, ScrollText, BarChart2 } from 'lucide-react';

// @formatter:off
const NAV_LINK_BASE   = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-muted transition-colors hover:text-content hover:bg-muted-bg';
const NAV_LINK_ACTIVE = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-content bg-muted-bg font-medium';
const STATS_BAR_KEY   = 'orch-stats-bar';
// @formatter:on

interface StatsBarData { total: number; running: number; failed: number; }

function StatsBar({ data }: { data: StatsBarData }): React.ReactElement {
  return (
    // violations-suppress: tailwind/no-raw-color-class stats bar uses specific count colors with no semantic token
    <div className="flex items-center gap-4 px-4 py-1 border-b border-border bg-surface text-xs text-muted">
      <span>{data.total} jobs</span>
      {data.running > 0 && <span className="text-primary">{data.running} running</span>}
      {data.failed > 0  && <span className="text-danger">{data.failed} failed</span>}
      {data.running === 0 && data.failed === 0 && <span className="text-success">All OK</span>}
    </div>
  );
}

export function NavBar(): React.ReactElement {
  const [showStats, setShowStats] = useState<boolean>(() => {
    try { return localStorage.getItem(STATS_BAR_KEY) === 'true'; } catch { return false; }
  });
  const [stats, setStats] = useState<StatsBarData | null>(null);

  const toggleStats = useCallback(() => {
    setShowStats(v => {
      const next = !v;
      try { localStorage.setItem(STATS_BAR_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!showStats) return;
    const load = (): void => {
      fetch('/api/jobs').then(r => r.json()).then((items: { job: { enabled: boolean }; runHistory: { exitCode: number | null }[] }[]) => {
        const total = items.length;
        const running = items.filter(i => i.runHistory[0]?.exitCode === null).length;
        const failed  = items.filter(i => {
          const e = i.runHistory[0]?.exitCode;
          return e !== null && e !== undefined && e !== 0;
        }).length;
        setStats({ total, running, failed });
      }).catch(() => { /* ignore */ });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [showStats]);

  return (
    <>
      <nav className="flex items-center h-11 px-4 border-b border-border bg-surface">
        <Link to="/" className="flex items-center gap-2 mr-6 shrink-0">
          <Layers size={16} className="text-primary" />
          <span className="text-sm font-semibold text-content">Orchestrator</span>
        </Link>
        <div className="flex items-center gap-1 flex-1">
          <NavLink to="/" end className={({ isActive }) => isActive ? NAV_LINK_ACTIVE : NAV_LINK_BASE}>
            <LayoutGrid size={14} />Jobs
          </NavLink>
          <NavLink to="/schedule" className={({ isActive }) => isActive ? NAV_LINK_ACTIVE : NAV_LINK_BASE}>
            <Calendar size={14} />Schedule
          </NavLink>
          <NavLink to="/audit" className={({ isActive }) => isActive ? NAV_LINK_ACTIVE : NAV_LINK_BASE}>
            <ScrollText size={14} />Audit
          </NavLink>
        </div>
        {/* violations-suppress: react/no-raw-button icon-only toggle - no Button variant for compact icon-only nav action */}
        <button onClick={toggleStats} title="Toggle stats bar"
          className={`p-1.5 rounded transition-colors ${showStats ? 'text-primary bg-muted-bg' : 'text-muted hover:text-content hover:bg-muted-bg'}`}>
          <BarChart2 size={14} />
        </button>
      </nav>
      {showStats && stats && <StatsBar data={stats} />}
    </>
  );
}
