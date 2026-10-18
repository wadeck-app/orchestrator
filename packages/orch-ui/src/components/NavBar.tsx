import React, { useCallback, useEffect, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Layers, LayoutGrid, Calendar, ScrollText, Moon, Sun } from 'lucide-react';
import { IconButton } from '@wadeck-app/dsl-ui';
import { NavStats } from './NavStats.js';

// @formatter:off
const NAV_LINK_BASE   = 'flex items-center gap-1.5 px-2 py-1 rounded text-sm text-muted transition-colors hover:text-content hover:bg-muted-bg';
const NAV_LINK_ACTIVE = 'flex items-center gap-1.5 px-2 py-1 rounded text-sm text-content bg-muted-bg font-medium';
const THEME_KEY       = 'orch-theme';
// @formatter:on

export function NavBar(): React.ReactElement {
  const [dark, setDark] = useState<boolean>(() => {
    try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch { return false; }
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
    try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* ignore */ }
  }, [dark]);

  const toggleDark = useCallback(() => setDark(v => !v), []);

  return (
    <nav className="flex items-center h-10 px-3 border-b border-border bg-surface">
      <Link to="/" className="flex items-center mr-5 shrink-0" title="Orchestrator">
        <Layers size={16} className="text-primary" />
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
      {/* Inline stats - always visible, compact */}
      <NavStats />
      {/* violations-suppress: react/no-raw-button icon-only toggle - no Button variant for compact icon-only nav action */}
      <IconButton icon={dark ? <Sun size={14} /> : <Moon size={14} />} aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggleDark} variant="ghost" size="icon-sm" />
    </nav>
  );
}
