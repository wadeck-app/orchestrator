import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// EventSource is not in jsdom - stub it so LogViewerSection can render
class MockEventSource {
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {}
  close() {}
}
beforeEach(() => { vi.stubGlobal('EventSource', MockEventSource); });
afterEach(() => { vi.unstubAllGlobals(); });
import { JobDetailSection } from './JobDetailSection.js';
import { LogViewerSection } from './LogViewerSection.js';
import type { Job, RuntimeEntry } from '../types.js';

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Test', command: 'echo hi',
  enabled: true, triggerMode: 'fire-and-forget',
};

const HISTORY: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 }];

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/jobs/j1']}>
      <JobDetailSection data={{ job: JOB, runHistory: HISTORY }} jobId="j1" />
    </MemoryRouter>
  );
}

function renderLogs() {
  return render(
    <MemoryRouter initialEntries={['/jobs/j1/logs']}>
      <LogViewerSection jobId="j1" />
    </MemoryRouter>
  );
}

describe('Back navigation - consistency between detail and log pages', () => {
  it('JobDetailSection back link text matches LogViewerSection back link text', () => {
    const { unmount: u1 } = renderDetail();
    const detailBackText = screen.getByRole('link', { name: /back/i }).textContent?.trim();
    u1();

    const { unmount: u2 } = renderLogs();
    const logsBackText = screen.getByRole('link', { name: /back/i }).textContent?.trim();
    u2();

    // Both must use identical text - no "Back to job" vs "Back" mismatch
    expect(detailBackText).toBe(logsBackText);
  });

  it('Both back links use identical className (same visual style)', () => {
    const { unmount: u1 } = renderDetail();
    const detailBackClass = screen.getByRole('link', { name: /back/i }).className;
    u1();

    const { unmount: u2 } = renderLogs();
    const logsBackClass = screen.getByRole('link', { name: /back/i }).className;
    u2();

    expect(detailBackClass).toBe(logsBackClass);
  });
});
