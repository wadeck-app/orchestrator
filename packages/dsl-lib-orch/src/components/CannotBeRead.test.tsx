import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { RunHistory } from './RunHistory.js';
import { AuditList } from './AuditList.js';
import { ScheduleTimeline } from './ScheduleTimeline.js';
import { JobCardGrid } from './JobCardGrid.js';

/*
 * A page whose source failed hands the component `loadError` (`$ctx.$sourceErrors.<source>`). The component must not
 * show its "no data" text then: "No runs yet" for a job that has runs is a lie, and an endless spinner says nothing.
 */
const down = { status: 503, message: 'daemon-not-running' };
const DOWN_TEXT = 'Cannot be read: the daemon is not running (orch start)';

describe('a table or list whose source failed says so', () => {
  it('RunHistory: no "No runs yet"', () => {
    render(<MemoryRouter><RunHistory entries={undefined as never} jobId="j1" loadError={down} /></MemoryRouter>);
    expect(screen.getByText(DOWN_TEXT)).toBeInTheDocument();
    expect(screen.queryByText('No runs yet')).toBeNull();
  });

  it('RunHistory: rows already loaded stay when a later refresh fails', () => {
    render(<MemoryRouter><RunHistory entries={[{ startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 }]} loadError={down} /></MemoryRouter>);
    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.queryByText(DOWN_TEXT)).toBeNull();
  });

  it('RunHistory: without a failure the empty text is unchanged', () => {
    render(<MemoryRouter><RunHistory entries={[]} /></MemoryRouter>);
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  it('AuditList: the message replaces the spinner', () => {
    render(<AuditList loadError={down} />);
    expect(screen.getByText(DOWN_TEXT)).toBeInTheDocument();
  });

  it('ScheduleTimeline: no "No upcoming cron jobs"', () => {
    render(<ScheduleTimeline loadError={down} />);
    expect(screen.getByText(DOWN_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(/No upcoming cron jobs/)).toBeNull();
  });

  it('JobCardGrid: the message replaces the spinner', () => {
    render(<MemoryRouter><JobCardGrid loadError={{ status: 500, message: 'boom' }} /></MemoryRouter>);
    expect(screen.getByText('Cannot be read: boom (HTTP 500)')).toBeInTheDocument();
  });
});
