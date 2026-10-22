import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { JobForm } from './JobForm.js';
import { JobCardGrid } from './JobCardGrid.js';
import { JobCard } from './JobCard.js';
import { JobConfigDisplay } from './JobConfigDisplay.js';
import { NextFireCountdown } from './NextFireCountdown.js';
import { JobFilterChips } from './JobFilterChips.js';
import type { Job, JobFormPayload } from '../types.js';

/*
 * A `manual` job is never fired by the scheduler. The dashboard offers it as a type, hides every
 * scheduling field for it, never sends missedFiring, and says on the card that it runs when triggered.
 */

const MANUAL: Job = {
  id: 'deploy', type: 'manual', label: 'Deploy', command: 'node deploy.js',
  enabled: true, triggerMode: 'fire-and-forget',
};
const CRON: Job = {
  id: 'nightly', type: 'cron', label: 'Nightly', command: 'echo tick',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *', missedFiring: 'catch-up',
};

function fill(label: RegExp, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function renderForm(onSubmit: (data: JobFormPayload) => Promise<void>, initial?: Partial<Job>) {
  return render(
    <MemoryRouter>
      <JobForm onSubmit={onSubmit} onCancel={() => {}} initial={initial} />
    </MemoryRouter>,
  );
}

describe('the form', () => {
  it('offers Manual in the type picker, with a one-line explanation', () => {
    renderForm(vi.fn().mockResolvedValue(undefined));
    expect(screen.queryByText(/runs only when you press Trigger/)).toBeNull();
    fill(/^Type/, 'manual');
    expect(screen.getByRole('option', { name: 'Manual' })).toBeInTheDocument();
    expect(screen.getByText(/runs only when you press Trigger/)).toBeInTheDocument();
  });

  it('hides every scheduling field for a manual job', () => {
    renderForm(vi.fn().mockResolvedValue(undefined));
    fill(/^Type/, 'manual');
    expect(screen.queryByLabelText(/^Schedule/)).toBeNull();
    expect(screen.queryByText(/Active period/)).toBeNull();
    expect(screen.queryByLabelText(/^Delay/)).toBeNull();
    expect(screen.queryByLabelText(/^Run at/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Advanced options/ }));
    expect(screen.queryByLabelText(/^Missed firing/)).toBeNull();
  });

  it('creates a manual job without a schedule or a missedFiring', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(onSubmit);
    fill(/^Id/, 'deploy');
    fill(/^Label/, 'Deploy');
    fill(/^Command/, 'node deploy.js');
    fill(/^Type/, 'manual');
    screen.getByRole('button', { name: 'Save' }).click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as JobFormPayload;
    expect(sent.type).toBe('manual');
    for (const field of ['schedule', 'missedFiring', 'delaySeconds', 'delayMs', 'scheduledAt', 'activeFrom', 'activeUntil']) {
      expect(sent, `${field} was sent for a manual job`).not.toHaveProperty(field);
    }
  });

  it('turning a cron job into a manual one sends no schedule and no missedFiring', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderForm(onSubmit, CRON);
    fill(/^Type/, 'manual');
    screen.getByRole('button', { name: 'Save' }).click();

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const sent = onSubmit.mock.calls[0]![0] as JobFormPayload;
    expect(sent.type).toBe('manual');
    expect(sent).not.toHaveProperty('schedule');
    expect(sent).not.toHaveProperty('missedFiring');
  });
});

describe('the cards and the list', () => {
  it('the card says it is never scheduled and how to run it, with a manual badge', () => {
    render(
      <MemoryRouter>
        <JobCard job={MANUAL} runHistory={[]} onTrigger={async () => {}} onToggle={async () => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText('manual')).toBeInTheDocument();
    expect(screen.getByText('Never scheduled; run with Trigger')).toBeInTheDocument();
  });

  it('the countdown never shows a time, a cron label or NaN', () => {
    render(<NextFireCountdown job={MANUAL} nowMs={Date.UTC(2026, 0, 1)} />);
    expect(screen.getByText('Never scheduled; run with Trigger')).toBeInTheDocument();
    expect(screen.queryByText(/NaN|Cron:|Starts in|Expires in/)).toBeNull();
  });

  it('the config display says there is no schedule rather than omitting the row', () => {
    render(<JobConfigDisplay job={MANUAL} />);
    expect(screen.getByText(/None: runs only when triggered/)).toBeInTheDocument();
  });

  const items = [MANUAL, CRON].map(job => ({ job, runHistory: [] }));

  it('the Manual filter keeps only manual jobs, All keeps both', () => {
    const { unmount } = render(<MemoryRouter><JobCardGrid items={items} filter="manual" /></MemoryRouter>);
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.queryByText('Nightly')).toBeNull();
    unmount();
    render(<MemoryRouter><JobCardGrid items={items} filter="all" /></MemoryRouter>);
    expect(screen.getByText('Deploy')).toBeInTheDocument();
    expect(screen.getByText('Nightly')).toBeInTheDocument();
  });

  it('the Cron and Once filters leave it out', () => {
    render(<MemoryRouter><JobCardGrid items={items} filter="cron" /></MemoryRouter>);
    expect(screen.queryByText('Deploy')).toBeNull();
  });

  it('the filter chips offer Manual', () => {
    render(<JobFilterChips selected="all" />);
    expect(screen.getByText('Manual')).toBeInTheDocument();
  });
});
