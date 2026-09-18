import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AuditEntryRow } from './AuditEntryRow.js';

const ENTRY = {
  ts: new Date().toISOString(),
  event: 'job.edited',
  label: 'WhatsApp scraper FROM UI',
  changes: 'label,type,command',
};

function row(): HTMLElement {
  const { container } = render(<AuditEntryRow entry={ENTRY} />);
  return container.firstElementChild as HTMLElement;
}

/*
 * Reported from a screenshot: on hover the highlight was flush against the text on both sides -
 * it began at the icon and stopped at the timestamp, so the row looked clipped rather than
 * selected. The row had `py-2` and no horizontal padding at all.
 *
 * The padding has to come with a matching negative margin: adding it alone would indent every row
 * and shift the whole list, and the ask was a nicer hover, not a new layout.
 */
describe('AuditEntryRow hover surface', () => {
  it('pads horizontally, so the hover highlight does not touch the text', () => {
    expect(row().className).toMatch(/(^|\s)px-2(\s|$)/);
  });

  it('cancels that padding with a negative margin, so the text does not move', () => {
    expect(row().className).toMatch(/(^|\s)-mx-2(\s|$)/);
  });

  it('still highlights on hover, with the themed surface token', () => {
    expect(row().className).toContain('hover:bg-muted-bg');
  });

  // Vertical padding was never the problem, and losing it would make the rows cramped.
  it('keeps its vertical padding', () => {
    expect(row().className).toMatch(/(^|\s)py-2(\s|$)/);
  });
});
