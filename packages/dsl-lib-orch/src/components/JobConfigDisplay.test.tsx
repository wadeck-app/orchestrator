import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { JobConfigDisplay } from './JobConfigDisplay.js';
import type { Job } from '../types.js';

const CRON_JOB: Job = {
  id: 'j1', type: 'cron', label: 'Test', command: 'pg_dump mydb',
  cwd: '/opt', schedule: '0 10 * * *', enabled: true,
  triggerMode: 'fire-and-forget', missedFiring: 'skip',
};
const STARTUP_JOB: Job = {
  id: 'j2', type: 'startup', label: 'Start', command: 'node server.js',
  enabled: true, triggerMode: 'wait', delaySeconds: 5,
};

describe('JobConfigDisplay', () => {
  it('shows command value', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('pg_dump mydb')).toBeInTheDocument();
  });

  it('shows schedule for cron jobs', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('0 10 * * *')).toBeInTheDocument();
  });

  it('shows delaySeconds for startup jobs', () => {
    render(<JobConfigDisplay job={STARTUP_JOB} />);
    expect(screen.getByText('5s')).toBeInTheDocument();
  });

  it('shows triggerMode value', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('fire-and-forget')).toBeInTheDocument();
  });

  it('shows missedFiring when present', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.getByText('skip')).toBeInTheDocument();
  });

  it('does not show schedule section for startup jobs', () => {
    render(<JobConfigDisplay job={STARTUP_JOB} />);
    expect(screen.queryByText('0 10 * * *')).toBeNull();
  });
});

// The job page shows the whole description, line breaks kept: it is text a person wrote to be read.
describe('JobConfigDisplay description', () => {
  it('shows the full text under a Description label, line breaks preserved', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, description: 'Line one.\nLine two.' }} />);

    expect(screen.getByText('Description')).toBeInTheDocument();
    const text = screen.getByText((_, el) => el?.textContent === 'Line one.\nLine two.' && el.tagName === 'P');
    expect(text.className).toContain('whitespace-pre-wrap');
  });

  it('shows no Description section when the job has none', () => {
    render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.queryByText('Description')).toBeNull();
  });
});

describe('JobConfigDisplay resource limits', () => {
  it('lists the effective values when they are customised', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, resourceLimits: { enforce: 'warn', hardFactor: 5, maxRamMb: 512 } }} />);

    expect(screen.getByText('Resource limits')).toBeInTheDocument();
    expect(screen.getByText('Enforcement: warn only (the monitor never ends a run)')).toBeInTheDocument();
    expect(screen.getByText('Hard factor: 5')).toBeInTheDocument();
    expect(screen.getByText('Max RAM: 512 MB')).toBeInTheDocument();
  });

  it.each([undefined, {}, { enforce: 'kill' as const }])('shows nothing about them for the defaults (%j)', (limits) => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, resourceLimits: limits }} />);

    expect(screen.queryByText('Resource limits')).toBeNull();
  });
});

// The mode only: the options can be long patterns and say nothing a reader needs on the card.
describe('JobConfigDisplay progress', () => {
  it('shows nothing for auto, set or absent', () => {
    const { rerender } = render(<JobConfigDisplay job={CRON_JOB} />);
    expect(screen.queryByText('Progress')).toBeNull();
    rerender(<JobConfigDisplay job={{ ...CRON_JOB, progress: 'auto' }} />);
    expect(screen.queryByText('Progress')).toBeNull();
  });

  it('shows off', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, progress: 'off' }} />);
    expect(screen.getByText('Progress')).toBeInTheDocument();
    expect(screen.getByText('off')).toBeInTheDocument();
  });

  it('shows the id of an explicit strategy', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, progress: 'log-learned' }} />);
    expect(screen.getByText('log-learned')).toBeInTheDocument();
  });

  it('shows the strategy and that it has options, without dumping them', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, progress: { strategy: 'ratio', options: { pattern: '(\d+)/(\d+)' } } }} />);
    expect(screen.getByText('ratio (with options)')).toBeInTheDocument();
    expect(screen.queryByText(/pattern/)).toBeNull();
  });

  it('shows a strategy object without options as the id alone', () => {
    render(<JobConfigDisplay job={{ ...CRON_JOB, progress: { strategy: 'history' } }} />);
    expect(screen.getByText('history')).toBeInTheDocument();
  });
});
