import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { RunHistory } from './RunHistory.js';

/*
 * A row names a run and says how it went, but offered no way to read it: getting to the output meant
 * going to the logs page and finding the run again in a dropdown, matching it by timestamp by eye.
 * The link carries the run, so the pane opens on that exact run.
 */
describe('RunHistory - reaching a run\'s output', () => {
  const entry = { startedAt: '2026-09-18T10:00:00Z', exitCode: 0, pid: 1 };

  it('links each run to its own logs, pinned to that run', () => {
    render(
      <MemoryRouter><RunHistory entries={[entry]} jobId="j1" /></MemoryRouter>
    );

    const link = screen.getByRole('link', { name: /logs/i });
    // The run name is the log file's own stamp: colons become dashes and the ms are dropped, which
    // is what RunLogger does when it names the file. Anything else deep-links to a run that is not
    // there, and the pane silently falls back to the live tail.
    expect(link.getAttribute('href')).toBe('/jobs/j1/logs?run=2026-09-18T10-00-00');
  });

  // The component is also used where the job is not known; a broken link is worse than none.
  it('omits the link when no job id is given', () => {
    render(<MemoryRouter><RunHistory entries={[entry]} /></MemoryRouter>);
    expect(screen.queryByRole('link', { name: /logs/i })).toBeNull();
  });
});

describe('RunHistory - exit code display in detail page', () => {
  it('shows "No runs yet" when empty', () => {
    render(<RunHistory entries={[]} />);
    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  it('shows exit code clearly labelled (not just parentheses)', () => {
    const entries = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: 1, pid: 123 }];
    render(<RunHistory entries={entries} />);
    // Must show "exit 1" clearly - not just "Failed (1)"
    expect(screen.getByText(/exit 1/i)).toBeInTheDocument();
    expect(screen.queryByText('Failed (1)')).toBeNull();
  });

  it('shows "Failed - exit 127" for exit code 127', () => {
    const entries = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: 127, pid: 1 }];
    render(<RunHistory entries={entries} />);
    expect(screen.getByText(/exit 127/i)).toBeInTheDocument();
  });

  it('shows OK badge for exit code 0', () => {
    const entries = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 }];
    render(<RunHistory entries={entries} />);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  // A scraper exiting 2 because a sibling holds its lock: the exit code is real, the failure is not.
  it('shows "Skipped" rather than the exit code for a skipped run', () => {
    const entries = [{ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: 2, pid: 7, skipped: true }];
    render(<RunHistory entries={entries} />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.queryByText(/exit 2/i)).toBeNull();
  });

  it('shows "Skipped", not "Cancelled", when the daemon never spawned anything', () => {
    const entries = [{ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: null, pid: null, skipped: true }];
    render(<RunHistory entries={entries} />);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
});
