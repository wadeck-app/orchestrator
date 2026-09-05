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
});
