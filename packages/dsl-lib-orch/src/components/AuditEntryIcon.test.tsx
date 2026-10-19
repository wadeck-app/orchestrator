import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AuditEntryIcon } from './AuditEntryIcon.js';

function icon(event: string, extra: Record<string, unknown> = {}): { shape: string; tone: string } {
  const entry = { ts: '2026-01-01T00:00:00Z', event, ...extra };
  const { container } = render(<AuditEntryIcon event={event} entry={entry} />);
  const cls = container.querySelector('svg')?.getAttribute('class') ?? '';
  return {
    shape: cls.split(/\s+/).find((c) => c.startsWith('lucide-')) ?? `no-lucide-class(${cls})`,
    tone: cls.split(/\s+/).find((c) => c.startsWith('text-')) ?? `no-tone(${cls})`,
  };
}

describe('AuditEntryIcon tones', () => {
  it('reads a job.completed with a non-zero exit as a failure', () => {
    expect(icon('job.completed', { exitCode: 3 }).tone).toBe('text-danger');
  });

  it('reads a job.completed with exit 0 as a success', () => {
    // violations-suppress: tailwind/no-raw-color-class asserts the class AuditEntryIcon itself uses (no semantic success token there)
    expect(icon('job.completed', { exitCode: 0 }).tone).toBe('text-green-600');
  });

  // The daemon audits a skipped run as job.skipped but keeps the child's real exit code (2 for the
  // scrapers' lock): neither the code nor the event may turn it red.
  it('does not read a skipped run as a failure, whatever exit code it kept', () => {
    const skipped = icon('job.skipped', { exitCode: 2, reason: 'skipExitCodes' });
    expect(skipped.tone).not.toBe('text-danger');
    expect(skipped.tone).not.toMatch(/no-tone/);
  });

  it('does not read a job.completed flagged skipped as a failure', () => {
    expect(icon('job.completed', { exitCode: 2, skipped: true }).tone).not.toBe('text-danger');
  });

  it('shows a refused trigger as a warning, not as a failure', () => {
    expect(icon('job.trigger_refused').tone).toBe('text-warning');
  });

  it('shows runs closed after a daemon death as a warning, not as a failure', () => {
    expect(icon('runs.orphaned_closed', { count: 2 }).tone).toBe('text-warning');
  });
});

describe('AuditEntryIcon shapes', () => {
  // Anything unknown falls back to the clock; an event that matters must not share it.
  const fallback = icon('something.unknown').shape;
  const events = ['job.skipped', 'job.trigger_refused', 'runs.orphaned_closed', 'daemon.start', 'daemon.restart'];

  it.each(events)('%s has its own shape, apart from the fallback clock', (event) => {
    expect(icon(event).shape).not.toBe(fallback);
  });

  it('gives those events shapes distinct from one another', () => {
    const shapes = events.map((e) => icon(e).shape);
    expect(new Set(shapes).size).toBe(events.length);
  });
});
