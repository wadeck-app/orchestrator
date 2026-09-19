import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JobCardGrid, getConsecutiveFailures } from './JobCardGrid.js';
import type { Job, RuntimeEntry } from '../types.js';

const JOB = (id: string, label: string): Job => ({
  id, type: 'cron', label, command: 'echo hi',
  enabled: true, triggerMode: 'fire-and-forget',
});
const HISTORY: RuntimeEntry[] = [];

function wrap(node: React.ReactNode) {
  return render(<MemoryRouter>{node}</MemoryRouter>);
}

describe('JobCardGrid', () => {
  it('renders spinner when items is undefined', () => {
    wrap(<JobCardGrid />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders correct number of cards when items provided', () => {
    wrap(<JobCardGrid items={[
      { job: JOB('j1', 'Job A'), runHistory: HISTORY },
      { job: JOB('j2', 'Job B'), runHistory: HISTORY },
    ]} />);
    expect(screen.getByText('Job A')).toBeInTheDocument();
    expect(screen.getByText('Job B')).toBeInTheDocument();
  });

  it('renders "No jobs" message when empty array', () => {
    wrap(<JobCardGrid items={[]} />);
    expect(screen.getByText(/no jobs/i)).toBeInTheDocument();
  });

  it('each card shows job label', () => {
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'My Cron'), runHistory: HISTORY }]} />);
    expect(screen.getByText('My Cron')).toBeInTheDocument();
  });
});

const FAILED = (code: number): RuntimeEntry => ({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: code, pid: 1 });
const SKIPPED = (code: number | null): RuntimeEntry => ({ startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:00:01Z', exitCode: code, pid: null, skipped: true });

describe('getConsecutiveFailures', () => {
  it('counts real failures at the head of the history', () => {
    expect(getConsecutiveFailures([FAILED(1), FAILED(2)])).toBe(2);
  });

  // The alert threshold is what turns this number red in the card, so a forgiven exit code
  // leaking into it is a false alarm on its own.
  it('does not count skipped runs, whatever exit code they carry', () => {
    expect(getConsecutiveFailures([SKIPPED(2), SKIPPED(null)])).toBe(0);
  });

  it('sees through a skipped run to the failures around it', () => {
    expect(getConsecutiveFailures([FAILED(1), SKIPPED(2), FAILED(1)])).toBe(2);
  });

  it('still stops at the first success', () => {
    expect(getConsecutiveFailures([FAILED(1), SKIPPED(2), { startedAt: '2026-09-02T10:00:00Z', exitCode: 0, pid: 1 }, FAILED(1)])).toBe(1);
  });
});

/**
 * Bulk actions had no test at all, which is how "select a job, click Delete, nothing happens"
 * shipped. The two things worth pinning are that the prompt guards both the self-owned and the
 * page-owned path, and that a self-owned fan-out reports back so the caller can refresh.
 */
describe('JobCardGrid bulk actions', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function selectFirstJob(extra: Partial<React.ComponentProps<typeof JobCardGrid>> = {}) {
    const user = userEvent.setup();
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'Job A'), runHistory: HISTORY }]} {...extra} />);
    await user.click(screen.getByLabelText('Select Job A'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
    return user;
  }

  /** The bulk bar's Delete and the dialog's Delete share a label, so the dialog has to be scoped. */
  const confirmDelete = () => within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' });

  it('asks before delegating a delete to the page', async () => {
    const onBulkDelete = vi.fn();
    const user = await selectFirstJob({ onBulkDelete });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    // The page owns the deletion, but it must not start until the reader has confirmed.
    expect(onBulkDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete 1 job?')).toBeInTheDocument();

    await user.click(confirmDelete());
    await waitFor(() => { expect(onBulkDelete).toHaveBeenCalledWith(['j1']); });
  });

  it('deletes through its own fetch and reports back when the page owns nothing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onAfterBulk = vi.fn();
    const user = await selectFirstJob({ onAfterBulk });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(confirmDelete());

    await waitFor(() => { expect(onAfterBulk).toHaveBeenCalled(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1', { method: 'DELETE' });
  });

  it('reports back after a self-owned enable so the caller can reload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onAfterBulk = vi.fn();
    const user = await selectFirstJob({ onAfterBulk });

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => { expect(onAfterBulk).toHaveBeenCalled(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/enable', { method: 'POST' });
  });

  it('does not reload when the page owns the enable -- the page reloads on its own', async () => {
    const onBulkEnable = vi.fn();
    const onAfterBulk = vi.fn();
    const user = await selectFirstJob({ onBulkEnable, onAfterBulk });

    await user.click(screen.getByRole('button', { name: 'Enable' }));

    await waitFor(() => { expect(onBulkEnable).toHaveBeenCalledWith(['j1']); });
    expect(onAfterBulk).not.toHaveBeenCalled();
  });
});

describe('JobCardGrid status column', () => {
  it('labels a skipped last run "Skipped"', () => {
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'Locked scraper'), runHistory: [SKIPPED(2)] }]} />);
    expect(screen.getAllByText('Skipped').length).toBeGreaterThan(0);
    expect(screen.queryByText('Cancelled')).toBeNull();
  });
});

/*
 * List view, which was a hand-rolled <table> and is now dsl-ui's DataTable.
 *
 * Worth its own block because the previous tests all run in grid view (the default), so the table
 * had no coverage at all -- the migration would have been verified by nothing.
 */
describe('JobCardGrid list view', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The view mode is persisted, so a test that switches it would otherwise leak into the next.
    try { localStorage.clear(); } catch { /* not available */ }
  });

  const ITEMS = [
    { job: JOB('j1', 'Job A'), runHistory: HISTORY },
    { job: JOB('j2', 'Job B'), runHistory: HISTORY },
  ];

  async function inListView(extra: Partial<React.ComponentProps<typeof JobCardGrid>> = {}) {
    const user = userEvent.setup();
    wrap(<JobCardGrid items={ITEMS} {...extra} />);
    await user.click(screen.getByLabelText('List view'));
    return user;
  }

  it('renders the columns and a row per job', async () => {
    await inListView();

    for (const header of ['Job', 'Type', 'Schedule', 'Status', 'Last run', 'Actions']) {
      expect(screen.getByText(header)).toBeInTheDocument();
    }
    expect(screen.getByText('Job A')).toBeInTheDocument();
    expect(screen.getByText('Job B')).toBeInTheDocument();
  });

  // DataTable's own navigateTo needs a RouterContext this app does not mount, so the row click goes
  // through onRowClick. Without it the whole row would be dead.
  it('clicking a row hands the job id to onJobClick', async () => {
    const onJobClick = vi.fn();
    const user = await inListView({ onJobClick });

    await user.click(screen.getByText('Job B'));

    expect(onJobClick).toHaveBeenCalledWith('j2');
  });

  it('the row checkbox selects without triggering the row click', async () => {
    const onJobClick = vi.fn();
    const user = await inListView({ onJobClick });

    await user.click(screen.getByLabelText('Select Job A'));

    expect(screen.getByText('1 selected')).toBeInTheDocument();
    expect(onJobClick).not.toHaveBeenCalled();
  });

  // TableColumn.label is a string, so select-all cannot be a header cell; it is in the toolbar, with
  // a visible label so it does not read as one more filter chip.
  it('select-all takes every visible job, and clears them again', async () => {
    const user = await inListView();
    const selectAll = screen.getByLabelText('Select all');

    await user.click(selectAll);
    expect(screen.getByText('2 selected')).toBeInTheDocument();

    await user.click(selectAll);
    expect(screen.queryByText(/selected/)).toBeNull();
  });

  it('selection survives a switch back to grid view, since one set drives both', async () => {
    const user = await inListView();

    await user.click(screen.getByLabelText('Select Job A'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Grid view'));
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('per-row Run now triggers that job without navigating', async () => {
    const onTrigger = vi.fn();
    const onJobClick = vi.fn();
    const user = await inListView({ onTrigger, onJobClick });

    await user.click(screen.getAllByRole('button', { name: 'Run now' })[0]!);

    expect(onTrigger).toHaveBeenCalledWith('j1');
    expect(onJobClick).not.toHaveBeenCalled();
  });

  it('DataTable owns the empty state, so the message is not doubled', async () => {
    const user = userEvent.setup();
    wrap(<JobCardGrid items={ITEMS} search="nothing matches this" />);
    await user.click(screen.getByLabelText('List view'));

    expect(screen.getAllByText('No jobs match the current filter.')).toHaveLength(1);
  });
});
