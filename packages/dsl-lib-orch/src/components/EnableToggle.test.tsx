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
  it('renders a switch that reflects the job enabled state', () => {
    render(<EnableToggle job={JOB} onToggle={vi.fn()} />);
    const checkbox = screen.getByRole('switch');
    expect(checkbox).toBeChecked();
  });

  it('renders unchecked when job.enabled is false', () => {
    render(<EnableToggle job={{ ...JOB, enabled: false }} onToggle={vi.fn()} />);
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('calls onToggle with false when unchecking an enabled job', async () => {
    const onToggle = vi.fn().mockResolvedValue(undefined);
    render(<EnableToggle job={JOB} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole('switch'));
    expect(onToggle).toHaveBeenCalledWith('j1', false);
  });

  it('reverts optimistic state if onToggle rejects', async () => {
    const onToggle = vi.fn().mockRejectedValue(new Error('oops'));
    render(<EnableToggle job={JOB} onToggle={onToggle} />);
    const checkbox = screen.getByRole('switch');
    await userEvent.click(checkbox);
    // After rejection, should be back to checked (original state)
    expect(checkbox).toBeChecked();
  });

  // The hint moved from a `title` attribute to dsl-ui's Tooltip, which renders it as real
  // text rather than relying on the browser's native tooltip - so it is reachable by
  // keyboard and by a screen reader, not only by hovering a mouse.
  it('explains what a click will do', () => {
    render(<EnableToggle job={JOB} onToggle={vi.fn()} />);

    expect(screen.getByText('Enabled - click to disable')).toBeInTheDocument();
  });

  it('flips the hint when the job is disabled', () => {
    render(<EnableToggle job={{ ...JOB, enabled: false }} onToggle={vi.fn()} />);

    expect(screen.getByText('Disabled - click to enable')).toBeInTheDocument();
  });

  // role=switch, not role=checkbox: a checkbox selects, a switch turns something on.
  it('reports itself as a switch', () => {
    render(<EnableToggle job={JOB} onToggle={vi.fn()} />);

    expect(screen.getByRole('switch')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
});
