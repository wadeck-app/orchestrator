import React from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Layers, LayoutGrid, Calendar, ScrollText } from 'lucide-react';

// @formatter:off
const NAV_LINK_BASE   = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-muted transition-colors hover:text-content hover:bg-muted-bg';
const NAV_LINK_ACTIVE = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-content bg-muted-bg font-medium';
// @formatter:on

export function NavBar(): React.ReactElement {
  return (
    <nav className="flex items-center h-11 px-4 border-b border-border bg-surface">
      <Link to="/" className="flex items-center gap-2 mr-6 shrink-0">
        <Layers size={16} className="text-primary" />
        <span className="text-sm font-semibold text-content">Orchestrator</span>
      </Link>
      <div className="flex items-center gap-1">
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
    </nav>
  );
}
