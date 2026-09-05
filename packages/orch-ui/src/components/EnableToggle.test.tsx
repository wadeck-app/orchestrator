import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { EnableToggle } from './EnableToggle.js';
import type { Job } from '../types.js';

const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Test job', command: 'echo hi',
  enabled: true, triggerMode: 'fire-and-forget',
};

describe('EnableToggle', () => {
  it('renders a checkbox that reflects the job enabled state', () => {
    render(<EnableToggle job={JOB} onToggle={vi.fn()} />);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('renders unchecked when job.enabled is false', () => {
    render(<EnableToggle job={{ ...JOB, enabled: false }} onToggle={vi.fn()} />);
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('calls onToggle with false when unchecking an enabled job', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<EnableToggle job={JOB} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith('j1', false);
  });

  it('reverts optimistic state if onToggle rejects', async () => {
    const onToggle = vi.fn().mockRejectedValue(new Error('oops'));
    render(<EnableToggle job={JOB} onToggle={onToggle} />);
    const checkbox = screen.getByRole('checkbox');
    await userEvent.click(checkbox);
    // After rejection, should be back to checked (original state)
    expect(checkbox).toBeChecked();
  });

  it('has a visible label with accessible tooltip', () => {
    render(<EnableToggle job={JOB} onToggle={vi.fn()} />);
    const label = screen.getByTitle('Enabled - click to disable');
    expect(label).toBeInTheDocument();
  });
});
