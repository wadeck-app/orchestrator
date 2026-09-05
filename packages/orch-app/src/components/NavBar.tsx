import React, { useCallback, useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Layers, LayoutGrid, Calendar, ScrollText, Bell, Moon, Sun } from 'lucide-react';

// @formatter:off
const NAV_LINK_BASE   = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-muted transition-colors hover:text-content hover:bg-muted-bg';
const NAV_LINK_ACTIVE = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-content bg-muted-bg font-medium';
const ICON_BTN_CLS    = 'p-1.5 rounded text-muted hover:text-content hover:bg-muted-bg transition-colors';
const THEME_KEY       = 'orch-theme';
// @formatter:on

interface StatsData { total: number; running: number; failed: number; }

export function NavBar(): React.ReactElement {
  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch { return false; }
  });
  const [stats, setStats] = useState<StatsData | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  const toggleDark = useCallback(() => setDark(v => !v), []);

  useEffect(() => {
    const load = (): void => {
      fetch('/api/jobs').then(r => r.json()).then((items: { job: { enabled: boolean }; runHistory: { exitCode: number | null }[] }[]) => {
        const total   = items.length;
        const running = items.filter(i => i.runHistory[0]?.exitCode === null && i.runHistory.length > 0).length;
        const failed  = items.filter(i => {
          const e = i.runHistory[0]?.exitCode;
          return e !== null && e !== undefined && e !== 0;
        }).length;
        setStats({ total, running, failed });
      }).catch(() => { /* daemon may be unavailable */ });
    };
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  return (
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
        <NavLink to="/webhooks" className={({ isActive }) => isActive ? NAV_LINK_ACTIVE : NAV_LINK_BASE}>
          <Bell size={14} />Webhooks
        </NavLink>
      </div>
      {/* Inline stats - always visible, compact */}
      {stats && (
        <div className="hidden sm:flex items-center gap-2 text-xs text-muted mr-3">
          <span>{stats.total} jobs</span>
          {stats.running > 0 && <span className="text-primary">{stats.running} running</span>}
          {stats.failed > 0  && <span className="text-danger">{stats.failed} failed</span>}
          {stats.running === 0 && stats.failed === 0 && <span className="text-success">All OK</span>}
        </div>
      )}
      {/* violations-suppress: react/no-raw-button icon-only toggle - no Button variant for compact icon-only nav action */}
      <button onClick={toggleDark} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        className={ICON_BTN_CLS}>
        {dark ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    </nav>
  );
}
