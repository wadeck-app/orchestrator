import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOrchUi, resetOrchUiConfig } from '../runtime-config.js';
import { FailureBanner } from './FailureBanner.js';

// A failure notice said "09:10, exit 1" and nothing more: finding out why meant opening the job, then its
// logs, then picking the run in a dropdown. The link opens the log of that exact run.
const FAILURES = [
  { jobId: 'a', jobLabel: 'Job A', entry: { startedAt: '2026-10-18T09:10:00.123Z', exitCode: 1, pid: 1 } },
];

afterEach(() => resetOrchUiConfig());

describe('FailureBanner log link', () => {
  function renderBanner(inRouter = true) {
    const banner = <FailureBanner failures={FAILURES} onAcknowledge={vi.fn()} onAcknowledgeAll={vi.fn()} />;
    return render(inRouter ? <MemoryRouter>{banner}</MemoryRouter> : banner);
  }

  it('links to the log of the failing run, named as RunLogger names it', () => {
    renderBanner();
    const link = screen.getByRole('link', { name: /log/i });
    expect(link.getAttribute('href')).toBe('/jobs/a/logs?run=2026-10-18T09-10-00');
  });

  it('carries the module route prefix when hosted inside app-core', () => {
    configureOrchUi({ routeBase: '/modules/orchestrator' });
    renderBanner();
    expect(screen.getByRole('link', { name: /log/i }).getAttribute('href'))
      .toBe('/modules/orchestrator/jobs/a/logs?run=2026-10-18T09-10-00');
  });

  // The overlay widget may be mounted outside any router; a router Link there throws.
  it('still renders a working link when mounted outside a router', () => {
    configureOrchUi({ routeBase: '/modules/orchestrator' });
    renderBanner(false);
    expect(screen.getByRole('link', { name: /log/i }).getAttribute('href'))
      .toBe('/modules/orchestrator/jobs/a/logs?run=2026-10-18T09-10-00');
  });

  it('keeps the exit code and the acknowledge button', () => {
    renderBanner();
    expect(screen.getByText('exit 1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('does not link a run without a start time, since it cannot be addressed', () => {
    render(
      <MemoryRouter>
        <FailureBanner
          failures={[{ jobId: 'a', entry: { startedAt: '', exitCode: 1, pid: 1 } }]}
          onAcknowledge={vi.fn()} onAcknowledgeAll={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).toBeNull();
  });
});
