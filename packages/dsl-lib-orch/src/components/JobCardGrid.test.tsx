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

/** What the server answers when a job is at its concurrency limit: a 200, not an error. */
const refusal = (): Response => new Response(
  JSON.stringify({ status: 'already-running', running: 1, maxConcurrency: 1 }),
  { status: 200, headers: { 'content-type': 'application/json' } },
);

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

  describe('Run now on the selection', () => {
    async function selectBoth(extra: Partial<React.ComponentProps<typeof JobCardGrid>> = {}) {
      const user = userEvent.setup();
      wrap(<JobCardGrid items={[
        { job: JOB('j1', 'Job A'), runHistory: HISTORY },
        { job: JOB('j2', 'Job B'), runHistory: HISTORY },
      ]} {...extra} />);
      await user.click(screen.getByLabelText('Select Job A'));
      await user.click(screen.getByLabelText('Select Job B'));
      // The bulk bar renders above the cards, so its button is the first "Run now".
      return { user, runSelection: () => user.click(screen.getAllByRole('button', { name: 'Run now' })[0]!) };
    }

    it('says nothing when every job started', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
      const onAfterBulk = vi.fn();
      const { runSelection } = await selectBoth({ onAfterBulk });

      await runSelection();

      await waitFor(() => { expect(onAfterBulk).toHaveBeenCalled(); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    // A fan-out that drops every response reports the same thing whether three jobs started or none
    // did. The count is what tells the reader which.
    it('counts the jobs that were already running', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })))
        .mockImplementationOnce(() => Promise.resolve(refusal()));
      const onAfterBulk = vi.fn();
      const { runSelection } = await selectBoth({ onAfterBulk });

      await runSelection();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('1 started, 1 already running.')).toBeInTheDocument();
      expect(onAfterBulk).toHaveBeenCalled();
    });

    it('names a request that failed rather than counting it as started', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 204 })))
        .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({ error: 'daemon-not-running' }), { status: 503 })));
      const { runSelection } = await selectBoth();

      await runSelection();

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/1 started, 1 failed/)).toBeInTheDocument();
      expect(within(dialog).getByText(/daemon-not-running/)).toBeInTheDocument();
    });
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

describe('JobCardGrid card Run now', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('triggers through its own request and tells the page to reload', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onAfterTrigger = vi.fn();
    const user = userEvent.setup();
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'Job A'), runHistory: HISTORY }]} onAfterTrigger={onAfterTrigger} />);

    await user.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => { expect(onAfterTrigger).toHaveBeenCalledTimes(1); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/trigger', { method: 'POST' });
  });

  // Nothing started, but the job's state may still have moved (it IS running), so the page reloads.
  it('shows the refusal on the button and still reloads', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.resolve(refusal()));
    const onAfterTrigger = vi.fn();
    const user = userEvent.setup();
    wrap(<JobCardGrid items={[{ job: JOB('j1', 'Job A'), runHistory: HISTORY }]} onAfterTrigger={onAfterTrigger} />);

    await user.click(screen.getByRole('button', { name: 'Run now' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Already running \(1\/1\)/ })).toBeInTheDocument();
    });
    expect(onAfterTrigger).toHaveBeenCalled();
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
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const onJobClick = vi.fn();
    const onAfterTrigger = vi.fn();
    const user = await inListView({ onJobClick, onAfterTrigger });

    await user.click(screen.getAllByRole('button', { name: 'Run now' })[0]!);

    await waitFor(() => { expect(onAfterTrigger).toHaveBeenCalled(); });
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/trigger', { method: 'POST' });
    expect(onJobClick).not.toHaveBeenCalled();
  });

  // The page used to own this POST through a brain, which can only see a status, never the 200 body
  // that says the run was refused. The row triggers itself now, so the refusal has somewhere to land.
  it('per-row Run now says so when the job is already running, and can run anyway', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => Promise.resolve(refusal()))
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const user = await inListView();

    await user.click(screen.getAllByRole('button', { name: 'Run now' })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/already running/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/1 of 1/)).toBeInTheDocument();
    // Nothing started yet: the reader has not chosen to go past the limit.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await user.click(within(dialog).getByRole('button', { name: 'Run anyway' }));

    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2); });
    expect(fetchMock).toHaveBeenLastCalledWith('/api/jobs/j1/trigger?force=true', { method: 'POST' });
  });

  it('per-row Run now reports a failed request instead of dropping it', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'daemon-not-running' }), { status: 503 }),
    );
    const user = await inListView();

    await user.click(screen.getAllByRole('button', { name: 'Run now' })[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/daemon-not-running/)).toBeInTheDocument();
  });

  it('DataTable owns the empty state, so the message is not doubled', async () => {
    const user = userEvent.setup();
    wrap(<JobCardGrid items={ITEMS} search="nothing matches this" />);
    await user.click(screen.getByLabelText('List view'));

    expect(screen.getAllByText('No jobs match the current filter.')).toHaveLength(1);
  });
});

// The page's search box used to match the label and the command only. A description is text someone
// wrote to find the job again, so it has to be searchable -- the whole text, not just the line a card shows.
describe('JobCardGrid search matches the description', () => {
  const items = [
    { job: { ...JOB('j1', 'Alpha'), description: 'Archives the invoices\nevery quarter' }, runHistory: HISTORY },
    { job: JOB('j2', 'Beta'), runHistory: HISTORY },
  ];

  it('finds a job by a word of its first line', () => {
    wrap(<JobCardGrid items={items} search="invoices" />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('finds a job by a word on a later line, whatever the case', () => {
    wrap(<JobCardGrid items={items} search="QUARTER" />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).toBeNull();
  });

  it('still finds by label and command, and a job without a description does not blow up', () => {
    wrap(<JobCardGrid items={items} search="beta" />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });
});
