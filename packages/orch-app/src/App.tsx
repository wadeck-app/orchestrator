import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { Layers, LayoutGrid, Calendar, ScrollText } from 'lucide-react';
import { GenericPageRunner } from '@wadeck-app/dsl-renderer';
import type { GenericPageRunnerProps } from '@wadeck-app/dsl-renderer';
import { useHeartbeat } from './hooks/useHeartbeat.js';
import { appRegistry } from './registry.js';
import { fetcher } from './fetcher.js';
import { api } from './api.js';
import type { FailureEntry } from './api.js';
import { FailureBanner } from '@wadeck-app/orch-ui';

import jobListYaml    from './dsl/pages/job-list.yaml?raw';
import jobDetailYaml  from './dsl/pages/job-detail.yaml?raw';
import jobFormNewYaml from './dsl/pages/job-form-new.yaml?raw';
import jobFormEditYaml from './dsl/pages/job-form-edit.yaml?raw';
import jobLogsYaml    from './dsl/pages/job-logs.yaml?raw';
import auditYaml      from './dsl/pages/audit.yaml?raw';
import scheduleYaml   from './dsl/pages/schedule.yaml?raw';

function KeyedPageRunner(props: Omit<GenericPageRunnerProps, 'key'> & { baseKey: string }) {
  const params = useParams();
  const paramSuffix = Object.values(params).filter(Boolean).join('/');
  const key = paramSuffix ? `${props.baseKey}/${paramSuffix}` : props.baseKey;
  return <GenericPageRunner key={key} yamlText={props.yamlText} registry={props.registry} fetcher={props.fetcher} />;
}

function useFailures() {
  const [failures, setFailures] = useState<FailureEntry[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await api.listFailures();
      setFailures(data);
    } catch { /* daemon may be unavailable transiently — keep previous state */ }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = setInterval(() => { void refresh(); }, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [refresh]);

  const acknowledgeAll = useCallback(async () => {
    try { await api.acknowledgeFailures(); setFailures([]); } catch { /* ignore */ }
  }, []);

  const acknowledgeOne = useCallback(async (jobId: string) => {
    try {
      await api.acknowledgeFailures();
      setFailures(prev => prev.filter(f => f.jobId !== jobId));
    } catch { /* ignore */ }
  }, []);

  return { failures, acknowledgeOne, acknowledgeAll };
}

// @formatter:off
const NAV_LINK_BASE   = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-muted transition-colors hover:text-content hover:bg-muted-bg';
const NAV_LINK_ACTIVE = 'flex items-center gap-1.5 px-2.5 py-1 rounded text-sm text-content bg-muted-bg font-medium';
// @formatter:on

function NavBar() {
  return (
    <nav className="flex items-center h-11 px-4 border-b border-border bg-surface">
      {/* Left: brand */}
      <Link to="/" className="flex items-center gap-2 mr-6 shrink-0">
        <Layers size={16} className="text-primary" />
        <span className="text-sm font-semibold text-content">Orchestrator</span>
      </Link>

      {/* Center: nav items */}
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

export default function App() {
  useHeartbeat();
  const { failures, acknowledgeOne, acknowledgeAll } = useFailures();
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-bg">
        <NavBar />
        <FailureBanner failures={failures} onAcknowledge={acknowledgeOne} onAcknowledgeAll={acknowledgeAll} />
        <Routes>
          <Route path="/" element={
            <GenericPageRunner key="/" yamlText={jobListYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/jobs/new" element={
            <GenericPageRunner key="/jobs/new" yamlText={jobFormNewYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/jobs/:id" element={
            <KeyedPageRunner baseKey="/jobs" yamlText={jobDetailYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/jobs/:id/edit" element={
            <KeyedPageRunner baseKey="/jobs/edit" yamlText={jobFormEditYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/jobs/:id/logs" element={
            <KeyedPageRunner baseKey="/jobs/logs" yamlText={jobLogsYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/audit" element={
            <GenericPageRunner key="/audit" yamlText={auditYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="/schedule" element={
            <GenericPageRunner key="/schedule" yamlText={scheduleYaml} registry={appRegistry} fetcher={fetcher} />
          } />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
