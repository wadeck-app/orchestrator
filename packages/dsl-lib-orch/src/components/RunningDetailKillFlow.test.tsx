import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RunningAlertDetail } from './RunningAlertDetail.js';
import { RunningBannerDetail } from './RunningBannerDetail.js';
import { RunningInlineDetail } from './RunningInlineDetail.js';
import type { Job, RuntimeEntry } from '../types.js';

// The Kill (Cancel) flow of the three running views: ask first, post only once confirmed, never claim a success the
// daemon did not give, and do not let a double click post twice.
const JOB: Job = { id: 'j1', type: 'startup', label: 'Job A', command: 'node server.js', enabled: true, triggerMode: 'fire-and-forget' };
const RUNNING: RuntimeEntry[] = [{ startedAt: '2026-09-02T10:00:00Z', exitCode: null, pid: 77 }];
const NEW_RUN: RuntimeEntry[] = [
  { startedAt: '2026-09-02T11:00:00Z', exitCode: null, pid: 88 },
  { startedAt: '2026-09-02T10:00:00Z', finishedAt: '2026-09-02T10:30:00Z', exitCode: null, endReason: 'manual-kill', pid: 77 },
];

const VARIANTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe.each(VARIANTS)('%s Kill flow', (_name, Detail) => {
  afterEach(() => { vi.restoreAllMocks(); });

  type Props = React.ComponentProps<typeof Detail>;
  const view = (props: Partial<Props>) => (
    <MemoryRouter><Detail job={JOB} jobId="j1" runHistory={RUNNING} {...props} /></MemoryRouter>
  );

  // The Kill button of the view, then the one of the dialog when it is open (it comes last).
  const killButtons = () => screen.queryAllByRole('button', { name: /^kill/i });
  const clickKill = async () => { await userEvent.click(killButtons()[0]!); };
  const confirmKill = async () => { const b = killButtons(); await userEvent.click(b[b.length - 1]!); };
  const QUESTION = 'Kill this process?';

  it('asks first, naming the process, and posts nothing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(view({}));

    await clickKill();

    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByText('PID 77. The job stops immediately.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declining posts nothing, closes the question and leaves the job shown as running', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    render(view({}));

    await clickKill();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(killButtons()).toHaveLength(1);
    expect(killButtons()[0]).toBeEnabled();
  });

  it('accepting posts the kill and then shows the not-running view', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
    render(view({}));

    await clickKill();
    await confirmKill();

    await waitFor(() => { expect(killButtons()).toHaveLength(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/j1/kill', { method: 'POST' });
    expect(screen.getByRole('button', { name: /run now/i })).toBeInTheDocument();
  });

  it('a refused kill keeps the job running and lets the user try again', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ error: 'access denied' }, 403));
    render(view({}));

    await clickKill();
    await confirmKill();

    await waitFor(() => { expect(screen.getByText('access denied')).toBeInTheDocument(); });
    expect(killButtons()).toHaveLength(1);
    expect(killButtons()[0]).toBeEnabled();
    expect(screen.queryByRole('button', { name: /run now/i })).toBeNull();
  });

  it('a network failure keeps the job running and says why', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    render(view({}));

    await clickKill();
    await confirmKill();

    await waitFor(() => { expect(screen.getByText(/network down/)).toBeInTheDocument(); });
    expect(killButtons()).toHaveLength(1);
    expect(killButtons()[0]).toBeEnabled();
  });

  it('a page-owned onKill gets the call after the confirmation, nothing is posted and no success is claimed', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const onKill = vi.fn();
    render(view({ onKill }));

    await clickKill();
    expect(onKill).not.toHaveBeenCalled();
    await confirmKill();

    expect(onKill).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    // The page decides the outcome (it reloads the job): the view must still be the running one.
    await waitFor(() => { expect(killButtons()[0]).toBeEnabled(); });
    expect(killButtons()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /run now/i })).toBeNull();
  });

  it('declining never reaches a page-owned onKill', async () => {
    const onKill = vi.fn();
    render(view({ onKill }));

    await clickKill();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onKill).not.toHaveBeenCalled();
  });

  it('is disabled while the kill is in flight, so a second click cannot post twice', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>((resolve) => { answer = resolve; }));
    render(view({}));

    await clickKill();
    await confirmKill();

    await waitFor(() => { expect(killButtons()[0]).toBeDisabled(); });
    // a click on the disabled button opens no new question
    await userEvent.click(killButtons()[0]!);
    expect(screen.queryByText(QUESTION)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(json({ ok: true }));
    await waitFor(() => { expect(killButtons()).toHaveLength(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('confirming twice in a row posts once (the question is closed by the first confirmation)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(() => {}));
    render(view({}));

    await clickKill();
    const confirm = killButtons().at(-1)!;
    await userEvent.dblClick(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forgets the kill when a new run starts, so the new process is shown', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ ok: true }));
    const { rerender } = render(view({}));
    await clickKill();
    await confirmKill();
    await waitFor(() => { expect(killButtons()).toHaveLength(0); });

    // same pid again: the optimistic "killed" stays
    rerender(view({ runHistory: [...RUNNING] }));
    expect(killButtons()).toHaveLength(0);

    // a new process (new pid) is running
    rerender(view({ runHistory: NEW_RUN }));

    await waitFor(() => { expect(killButtons()).toHaveLength(1); });
    expect(screen.queryByRole('button', { name: /run now/i })).toBeNull();
  });
});

describe('RunningInlineDetail Kill label', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads "Killing..." while the call is in flight', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise<Response>(() => {}));
    render(<MemoryRouter><RunningInlineDetail job={JOB} jobId="j1" runHistory={RUNNING} /></MemoryRouter>);

    await userEvent.click(screen.getByRole('button', { name: 'Kill' }));
    const buttons = screen.getAllByRole('button', { name: 'Kill' });
    await userEvent.click(buttons[buttons.length - 1]!);

    expect(await screen.findByRole('button', { name: 'Killing...' })).toBeDisabled();
  });
});
