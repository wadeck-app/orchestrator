import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { RunHistory } from './RunHistory.js';

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
