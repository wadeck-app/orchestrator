import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobDetailActions } from './JobDetailActions.js';
import type { Job } from '../types.js';

const JOB: Job = { id: 'j1', type: 'cron', label: 'Test', command: 'e', enabled: true, triggerMode: 'fire-and-forget' };

afterEach(() => { vi.restoreAllMocks(); });

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('JobDetailActions', () => {
  it('renders View logs link', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('link', { name: /view logs/i })).toBeInTheDocument();
  });

  it('View logs link points to /jobs/:id/logs', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('link', { name: /view logs/i })).toHaveAttribute('href', '/jobs/j1/logs');
  });

  it('renders Edit link', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('link', { name: /edit/i })).toBeInTheDocument();
  });

  it('renders Delete button', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
  });

  it('renders Run now button', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
  });

  it('renders enable/disable toggle', () => {
    wrap(<JobDetailActions job={JOB} jobId="j1" />);
    expect(screen.getByRole('checkbox')).toBeInTheDocument();
  });
});
