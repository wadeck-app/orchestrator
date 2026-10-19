import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobCard, runDotState } from './JobCard.js';
import type { Job, RuntimeEntry } from '../types.js';

const BASE_JOB: Job = {
  id: 'j1', type: 'cron', label: 'WhatsApp', command: 'wa-scraper',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 10 * * *',
};

function entry(exitCode: number | null, pid = 1): RuntimeEntry {
  return { startedAt: '2026-09-02T10:00:00Z', exitCode, pid };
}

// Per the daemon contract a skipped run always has finishedAt, and its exitCode is either the
// child's own code or null when nothing was spawned.
function skipped(exitCode: number | null = 2): RuntimeEntry {
  return { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode, pid: null, skipped: true };
}

function renderCard(runHistory: RuntimeEntry[]) {
  return render(
    <MemoryRouter>
      <JobCard job={BASE_JOB} runHistory={runHistory} onTrigger={vi.fn()} onToggle={vi.fn()} />
    </MemoryRouter>
  );
}

// A run in progress used to be a grey dot among the coloured ones, which reads as "no result"
// rather than "going". It is a blue play triangle now.
describe('JobCard run history dots', () => {
  it('marks a run in progress with a play icon, not a dot', () => {
    const { container } = renderCard([entry(null)]);

    const running = container.querySelector('[data-run-state="running"]');
    expect(running).not.toBeNull();
    // An svg, so it is the icon and not a recoloured circle.
    expect(running!.tagName.toLowerCase()).toBe('svg');
    expect(screen.getByLabelText('Running')).toBeInTheDocument();
  });

  // Blue, via the semantic token. Amber would read as a warning, and a run in progress is not one.
  it('colours the running icon with the primary token rather than a grey or amber literal', () => {
    const { container } = renderCard([entry(null)]);

    const running = container.querySelector('[data-run-state="running"]')!;
    expect(running.getAttribute('class')).toContain('text-primary');
    expect(running.getAttribute('class')).not.toContain('gray');
    expect(running.getAttribute('class')).not.toContain('orange');
    expect(running.getAttribute('class')).not.toContain('yellow');
  });

  it('still draws finished runs as dots', () => {
    const { container } = renderCard([entry(0), entry(1)]);

    expect(container.querySelector('[data-run-state="ok"]')!.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('[data-run-state="failed"]')!.tagName.toLowerCase()).toBe('span');
    expect(container.querySelector('[data-run-state="running"]')).toBeNull();
  });

  it('always shows five slots, padding with empties', () => {
    const { container } = renderCard([entry(0)]);
    expect(container.querySelectorAll('[data-run-state]').length).toBe(5);
    expect(container.querySelectorAll('[data-run-state="empty"]').length).toBe(4);
  });
});

describe('runDotState', () => {
  it('maps every case', () => {
    expect(runDotState(undefined)).toBe('empty');
    expect(runDotState(entry(null))).toBe('running');
    expect(runDotState(entry(0))).toBe('ok');
    expect(runDotState(entry(1))).toBe('failed');
  });

  // The false alarm being removed: the exit code the daemon was told to forgive used to paint
  // the dot red, and a skipped run with no exit code painted it amber for "cancelled".
  it('gives a skipped run its own state, whatever the exit code says', () => {
    expect(runDotState(skipped(2))).toBe('skipped');
    expect(runDotState(skipped(null))).toBe('skipped');
  });

  it('draws the skipped dot muted - never red, never green', () => {
    const { container } = renderCard([skipped(2)]);

    const dot = container.querySelector('[data-run-state="skipped"]')!;
    expect(dot.getAttribute('class')).toContain('bg-muted');
    expect(dot.getAttribute('class')).not.toContain('red');
    expect(dot.getAttribute('class')).not.toContain('green');
  });
});

describe('JobCard status badge on the list page', () => {
  it('shows "Never run" when no history', () => {
    renderCard([]);
    expect(screen.getByText('Never run')).toBeInTheDocument();
  });

  it('shows "OK" when last run succeeded', () => {
    renderCard([entry(0)]);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('shows "5x failed" when 5 consecutive failures - NOT "Failed (1)"', () => {
    renderCard([entry(1), entry(1), entry(1), entry(1), entry(1)]);
    // Must show count, not exit code
    expect(screen.getByText('5x failed')).toBeInTheDocument();
    expect(screen.queryByText(/Failed \(/)).toBeNull();
  });

  it('shows "3x failed" for 3 failures even with different exit codes', () => {
    renderCard([entry(1), entry(2), entry(127)]);
    expect(screen.getByText('3x failed')).toBeInTheDocument();
  });

  it('shows "1x failed" for a single failure', () => {
    renderCard([entry(1)]);
    expect(screen.getByText('1x failed')).toBeInTheDocument();
  });

  it('shows "OK" when latest run succeeded even if prior runs failed', () => {
    renderCard([entry(0), entry(1), entry(1)]);
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('labels a skipped last run "Skipped" rather than failed or cancelled', () => {
    renderCard([skipped(2)]);
    expect(screen.getByText('Skipped')).toBeInTheDocument();
    expect(screen.queryByText(/failed/i)).toBeNull();
    expect(screen.queryByText('Cancelled')).toBeNull();
  });

  it('keeps skipped runs out of the failure count', () => {
    renderCard([entry(1), skipped(2), entry(1)]);
    expect(screen.getByText('2x failed')).toBeInTheDocument();
  });
});

// Transparent means exactly that: neither an extra success nor a break.
describe('JobCard success streak', () => {
  it('is not broken by a skipped run in the middle', () => {
    renderCard([entry(0), skipped(2), entry(0)]);
    expect(screen.getByText('2 streak')).toBeInTheDocument();
  });

  it('does not count the skipped run as a success', () => {
    renderCard([entry(0), skipped(2), entry(0), skipped(null)]);
    expect(screen.getByText('2 streak')).toBeInTheDocument();
  });

  it('still ends the streak on the first real failure', () => {
    renderCard([entry(0), skipped(2), entry(0), entry(1), entry(0)]);
    expect(screen.getByText('2 streak')).toBeInTheDocument();
  });
});

// The pill says "Failed" at one failure; the counter is for when it has become a pattern. It used to wait
// for alertAfterFailures (default 3), which hid a job that had failed twice running.
describe('JobCard consecutive failures counter', () => {
  const NOW = Date.parse('2026-09-02T12:00:00Z');
  // Newest first, as JobCardGrid passes them.
  const HISTORY: RuntimeEntry[] = [
    { startedAt: '2026-09-02T11:00:00Z', exitCode: 1, pid: 1 },
    { startedAt: '2026-09-02T10:00:00Z', exitCode: 1, pid: 1 },
    { startedAt: '2026-09-02T09:00:00Z', exitCode: 0, pid: 1 },
  ];

  function renderWith(consecutiveFailures: number | undefined, job: Job = BASE_JOB, history: RuntimeEntry[] = HISTORY) {
    return render(
      <MemoryRouter>
        <JobCard job={job} runHistory={history} consecutiveFailures={consecutiveFailures} nowMs={NOW}
                 onTrigger={vi.fn()} onToggle={vi.fn()} />
      </MemoryRouter>
    );
  }

  it('shows the count from two failures, below the default alert threshold of 3', () => {
    renderWith(2);
    expect(screen.getByText('2 fails')).toBeInTheDocument();
  });

  it('shows nothing at a single failure, where the status pill already says Failed', () => {
    renderWith(1, BASE_JOB, [HISTORY[0], HISTORY[2]]);
    expect(screen.queryByText(/\bfails\b/)).toBeNull();
  });

  it('shows nothing without a count', () => {
    renderWith(undefined);
    expect(screen.queryByText(/\bfails\b/)).toBeNull();
  });

  it('states the count and since when in the tooltip', () => {
    renderWith(2);
    // The oldest failure of the streak (10:00), not the last success and not the newest failure.
    expect(screen.getByText('2 failures in a row, since 2h ago')).toBeInTheDocument();
  });

  it('shows the count from two even when the job sets a higher alertAfterFailures', () => {
    renderWith(2, { ...BASE_JOB, alertAfterFailures: 5 });
    expect(screen.getByText('2 fails')).toBeInTheDocument();
  });
});

// The description is documentation: a card shows only its first line, on one line, with the whole
// text one hover away. A job without one must not get a taller card.
describe('JobCard description', () => {
  function cardWith(description: string | undefined) {
    return render(
      <MemoryRouter>
        <JobCard job={{ ...BASE_JOB, description }} runHistory={[]} onTrigger={vi.fn()} onToggle={vi.fn()} />
      </MemoryRouter>
    );
  }

  it('shows the first line only, with the full text as its title', () => {
    cardWith('Backs up the database.\nRuns before the export.');

    const line = screen.getByText('Backs up the database.');
    expect(line.getAttribute('title')).toBe('Backs up the database.\nRuns before the export.');
    expect(screen.queryByText(/Runs before the export/)).toBeNull();
  });

  it('is truncated to one line by CSS, not cut in the text', () => {
    cardWith('x'.repeat(500));

    const line = screen.getByText('x'.repeat(500));
    expect(line.className).toContain('truncate');
  });

  it('adds no element at all when the job has no description', () => {
    const without = cardWith(undefined).container.innerHTML;
    expect(without).not.toContain('data-job-description');
    expect(cardWith('   ').container.querySelector('[data-job-description]')).toBeNull();
  });

  it('is a plain paragraph under the label, not a tooltip-only secret', () => {
    const { container } = cardWith('Visible text');
    const p = container.querySelector('[data-job-description]')!;
    expect(p.tagName.toLowerCase()).toBe('p');
    expect(p.textContent).toBe('Visible text');
  });
});
