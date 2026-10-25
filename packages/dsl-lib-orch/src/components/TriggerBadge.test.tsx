import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TriggerBadge } from './TriggerBadge.js';

describe('TriggerBadge', () => {
  // The CLI writes { kind: 'retry' } for a run it started again after a retryable exit code.
  // It used to fall through to the manual branch and read as a person clicking Run.
  it('renders a retry as "retry #n", not as manual', () => {
    render(<TriggerBadge source={{ kind: 'retry', attempt: 3 }} />);
    expect(screen.getByText('retry #3')).toBeInTheDocument();
    expect(screen.queryByText(/manual/)).toBeNull();
  });

  it('gives a retry a look of its own, distinct from manual', () => {
    const { container: retry } = render(<TriggerBadge source={{ kind: 'retry', attempt: 1 }} />);
    const { container: manual } = render(<TriggerBadge source={{ kind: 'manual' }} />);
    expect(retry.firstElementChild?.className).not.toBe(manual.firstElementChild?.className);
  });

  // restartOnExit starts the job again after any exit; it must not fall through to the manual branch like retry once did.
  it('renders a restart as "restart #n", not as manual, and not as a retry', () => {
    render(<TriggerBadge source={{ kind: 'restart', attempt: 2 }} />);
    expect(screen.getByText('restart #2')).toBeInTheDocument();
    expect(screen.queryByText(/manual/)).toBeNull();
    expect(screen.queryByText(/retry/)).toBeNull();
  });

  it('still renders manual, cron and dependency', () => {
    render(<TriggerBadge source={{ kind: 'manual', ip: '1.2.3.4' }} />);
    expect(screen.getByText('manual - 1.2.3.4')).toBeInTheDocument();
    render(<TriggerBadge source={{ kind: 'dependency', dependsOnJobId: 'a' }} />);
    expect(screen.getByText('dep: a')).toBeInTheDocument();
  });
});
