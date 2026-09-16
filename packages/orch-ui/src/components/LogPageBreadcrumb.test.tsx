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

  // Colour and spacing separate the crumbs. A middle dot was tried and rejected: punctuation
  // dropped between words to imply structure is decoration, and it has to stay out of the UI.
  it('uses no separator glyph between the crumbs', () => {
    renderCrumb({ jobId: 'j1', jobLabel: 'WhatsApp scraper' });

    const text = screen.getByTestId('log-breadcrumb').textContent ?? '';
    // Codepoints, never literals: several of these are themselves shared/no-em-dash violations, so
    // spelling them out would make this test fail its own project rules. The number also says
    // exactly which character is meant, where the glyphs are easy to confuse on screen.
    const forbidden = [0x00b7, 0x2022, 0x2023, 0x203a, 0x00bb, 0x2014, 0x2013, 0x007c];
    for (const cp of forbidden) {
      const label = `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
      expect(text, `separator ${label} is back in the breadcrumb`)
        .not.toContain(String.fromCharCode(cp));
    }
  });

  // The log page grew its own back link with different padding, which put its arrow 9px above
  // every other page's. Sharing BackLink's classes is what keeps the headers on one baseline.
  it('reuses BackLink spacing rather than restating it', async () => {
    const { BACK_ROW_CLS, BACK_LINK_CLS } = await import('./BackLink.js');
    renderCrumb({ jobId: 'j1', jobLabel: 'x' });

    const row = screen.getByTestId('log-breadcrumb').parentElement!;
    expect(row.className).toBe(BACK_ROW_CLS);

    const back = screen.getByRole('link', { name: 'Back' });
    for (const cls of BACK_LINK_CLS.split(' ')) {
      expect(back.className, `back link is missing ${cls}`).toContain(cls);
    }
  });
});
