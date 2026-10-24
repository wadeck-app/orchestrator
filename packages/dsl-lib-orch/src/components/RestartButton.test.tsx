import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { RestartButton } from './RestartButton.js';
import type { Job } from '../types.js';

// The wording of the answer to a Restart: what the daemon did, not what the user hoped for.
const JOB: Job = {
  id: 'svc', type: 'startup', label: 'Service', command: 'node server.js',
  enabled: true, triggerMode: 'fire-and-forget', timeoutSeconds: 0,
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => { vi.restoreAllMocks(); });

async function restartWith(body: unknown, job: Job = JOB): Promise<void> {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(json(body));
  render(<RestartButton job={job} jobId={job.id} running />);
  await userEvent.click(screen.getByRole('button', { name: 'Restart' }));
  await userEvent.click(screen.getByRole('button', { name: 'Yes, restart' }));
}

describe('RestartButton answer wording', () => {
  it('says the pid is unknown when the daemon started the job without giving one', async () => {
    await restartWith({ id: 'svc', wasRunning: true, killed: 1, started: true, pid: null });

    expect(await screen.findByText('Service was restarted (new pid unknown).')).toBeInTheDocument();
  });

  it('names the job by its id when it has no label', async () => {
    const { label: _label, ...unlabelled } = JOB;
    // A job read from an older registry may have no label: the type says it always has one.
    await restartWith({ id: 'svc', wasRunning: true, killed: 1, started: true, pid: 12 }, unlabelled as Job);

    expect(await screen.findByText('svc was restarted (new pid 12).')).toBeInTheDocument();
  });

  it('says the old instance was ended when the job could not be started again', async () => {
    await restartWith({ id: 'svc', wasRunning: true, killed: 1, started: false, pid: null, reason: 'port 80 is still in use' });

    expect(await screen.findByText('The running instance was ended but the job was not started again. port 80 is still in use')).toBeInTheDocument();
    expect(screen.getByText('Not restarted')).toBeInTheDocument();
  });

  it('does not claim an instance was ended when none was running', async () => {
    await restartWith({ id: 'svc', wasRunning: false, killed: 0, started: false, pid: null, reason: 'the job is disabled' });

    expect(await screen.findByText('the job is disabled')).toBeInTheDocument();
    expect(screen.queryByText(/was ended/)).toBeNull();
  });

  it('admits when the daemon gave no reason', async () => {
    await restartWith({ id: 'svc', wasRunning: false, killed: 0, started: false, pid: null });

    expect(await screen.findByText('The daemon gave no reason.')).toBeInTheDocument();
  });

  it('keeps the ended-instance warning even when no reason came with it', async () => {
    await restartWith({ id: 'svc', wasRunning: true, killed: 1, started: false, pid: null });

    expect(await screen.findByText('The running instance was ended but the job was not started again. The daemon gave no reason.')).toBeInTheDocument();
  });
});

describe('RestartButton visibility', () => {
  it('renders nothing for a job that is not running', () => {
    const { container } = render(<RestartButton job={JOB} jobId="svc" running={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing for a job with a timeout', () => {
    const { container } = render(<RestartButton job={{ ...JOB, timeoutSeconds: 60 }} jobId="svc" running />);
    expect(container.firstChild).toBeNull();
  });
});
