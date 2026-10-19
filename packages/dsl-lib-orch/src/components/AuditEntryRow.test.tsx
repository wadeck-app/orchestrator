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

describe('AuditEntryRow details', () => {
  function details(entry: Record<string, unknown>): string {
    const { container } = render(<AuditEntryRow entry={{ ts: new Date().toISOString(), event: 'job.completed', ...entry }} />);
    return container.textContent ?? '';
  }

  // audit-wiring writes durationMs, never startedAt/finishedAt: the duration used to be missing.
  it('shows the duration the daemon writes (durationMs) as readable text', () => {
    const text = details({ label: 'scrape', exitCode: 0, durationMs: 1500 });
    expect(text).toContain('1.5s');
    expect(text).not.toContain('durationMs=');
  });

  it('formats a long durationMs in minutes', () => {
    expect(details({ exitCode: 0, durationMs: 125_000 })).toContain('2m 5s');
  });

  it('still derives the duration from startedAt/finishedAt when only those are present', () => {
    const text = details({ exitCode: 0, startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-01-01T00:00:02Z' });
    expect(text).toContain('2.0s');
  });

  it('shows the trigger and the reason as words, not key=value', () => {
    const text = details({ event: 'job.skipped', exitCode: 2, trigger: 'cron', reason: 'concurrency' });
    expect(text).toContain('cron');
    expect(text).toContain('concurrency');
    expect(text).not.toContain('trigger=');
    expect(text).not.toContain('reason=');
  });

  it('shows the ip as "from <ip>" for any event that carries one', () => {
    const text = details({ event: 'job.killed_manual', ip: '10.0.0.2' });
    expect(text).toContain('from 10.0.0.2');
    expect(text).not.toContain('ip=');
  });

  it('shows a zero durationMs on a skip without noise', () => {
    expect(details({ event: 'job.skipped', durationMs: 0, reason: 'liveness' })).not.toContain('durationMs=');
  });
});
