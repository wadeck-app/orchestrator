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

  // The name comes from visible text, not an aria-label. It must match
  // JobDetailSection's wording, which BackLink.test.tsx pins to "Back".
  it('exposes an accessible back link pointing at the job', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    const back = screen.getByRole('link', { name: 'Back' });
    expect(back).toHaveAttribute('href', '/jobs/j1');
  });

  // The arrow used to be icon-only, which left the job name pressed against it and made the
  // arrow read as part of the name rather than as the way out.
  it('labels the arrow with visible text, and keeps the job name out of the link', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    const back = screen.getByRole('link', { name: 'Back' });
    expect(back.textContent).toBe('Back');
    expect(back.textContent).not.toContain('WhatsApp scraper');
    // Visible, so it survives a reader that ignores aria-label as well as one that reads it.
    expect(back.getAttribute('aria-label')).toBeNull();
  });

  it('falls back to the job id when the job has no label', () => {
    renderCrumb({ jobId: 'j1' });

    expect(screen.getByTestId('log-breadcrumb')).toHaveTextContent('j1');
  });

  // The separators are decorative; screen readers would otherwise announce them between the
  // crumbs. Selected by content rather than by position: the arrow is aria-hidden too, and a
  // querySelector for the first hidden node silently started matching the icon instead.
  it('hides every separator from assistive technology', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'x' });

    const hidden = [...screen.getByTestId('log-breadcrumb').querySelectorAll('[aria-hidden="true"]')];
    const separators = hidden.filter(el => el.textContent === '·');
    expect(separators.length).toBe(2);
    // Nothing carrying the middot may be left announced.
    const announced = [...screen.getByTestId('log-breadcrumb').querySelectorAll('span')]
      .filter(el => el.textContent === '·' && el.getAttribute('aria-hidden') !== 'true');
    expect(announced).toEqual([]);
  });
});
