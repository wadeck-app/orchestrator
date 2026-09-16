import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { LogPageBreadcrumb } from './LogPageBreadcrumb.js';

function renderCrumb(props: { jobId: string; jobLabel?: string }) {
  return render(
    <MemoryRouter initialEntries={[`/jobs/${props.jobId}/logs`]}>
      <LogPageBreadcrumb {...props} />
    </MemoryRouter>
  );
}

describe('LogPageBreadcrumb', () => {
  it('puts the job name and the page kind on one compact row', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    const row = screen.getByTestId('log-breadcrumb');
    expect(row).toHaveTextContent('WhatsApp scraper');
    expect(row).toHaveTextContent('Logs');
    // text-sm, not a page-title size.
    expect(row.className).toMatch(/text-sm/);
  });

  // The dark pane below already reads as a log, so a page-level heading plus a
  // "Logs" subtitle only cost vertical space.
  it('renders no page-level heading element', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    expect(screen.queryByRole('heading')).toBeNull();
  });

  // Icon-only link, so the accessible name has to come from aria-label. It must
  // match JobDetailSection's wording, which BackLink.test.tsx pins to "Back".
  it('exposes an accessible back link pointing at the job', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    const back = screen.getByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/jobs/j1');
  });

  it('falls back to the job id when the job has no label', () => {
    renderCrumb({ jobId: 'j1' });

    expect(screen.getByTestId('log-breadcrumb')).toHaveTextContent('j1');
  });

  // The separator is decorative; screen readers would otherwise announce it
  // between the job name and the page kind.
  it('hides the separator from assistive technology', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'x' });

    const sep = screen.getByTestId('log-breadcrumb').querySelector('[aria-hidden="true"]');
    expect(sep).not.toBeNull();
    expect(sep!.textContent).toBe('·');
  });
});
