import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobToggle } from './JobToggle.js';
import type { Job } from '../types.js';

const JOB_ON: Job  = { id: 'j1', type: 'cron', label: 'T', command: 'e', enabled: true,  triggerMode: 'fire-and-forget' };
const JOB_OFF: Job = { id: 'j1', type: 'cron', label: 'T', command: 'e', enabled: false, triggerMode: 'fire-and-forget' };

afterEach(() => { vi.restoreAllMocks(); });

describe('JobToggle', () => {
  it('renders checkbox checked when job.enabled=true', () => {
    render(<JobToggle job={JOB_ON} />);
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('renders checkbox unchecked when job.enabled=false', () => {
    render(<JobToggle job={JOB_OFF} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('calls /api/jobs/j1/disable when enabled job is toggled off', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    render(<JobToggle job={JOB_ON} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(fetch).toHaveBeenCalledWith('/api/jobs/j1/disable', { method: 'POST' });
  });

  it('calls /api/jobs/j1/enable when disabled job is toggled on', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true } as Response);
    render(<JobToggle job={JOB_OFF} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(fetch).toHaveBeenCalledWith('/api/jobs/j1/enable', { method: 'POST' });
  });
});
