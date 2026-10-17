import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Job } from './types.js';
import { RunningAlertDetail } from './components/RunningAlertDetail.js';
import { RunningBannerDetail } from './components/RunningBannerDetail.js';
import { RunningInlineDetail } from './components/RunningInlineDetail.js';

/*
 * The job page mounts these before its data has arrived (job is undefined), then again with the job.
 * Each used to return null ahead of its hooks, so the first render called none and the next called
 * several: React logs "Internal React error: Expected static flag was missing" in development.
 */
const JOB: Job = {
  id: 'j1', type: 'cron', label: 'Job A', command: 'echo hi', schedule: '0 9 * * *',
  enabled: true, triggerMode: 'fire-and-forget',
};

const COMPONENTS = [
  ['RunningAlertDetail', RunningAlertDetail],
  ['RunningBannerDetail', RunningBannerDetail],
  ['RunningInlineDetail', RunningInlineDetail],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(COMPONENTS)('%s hook order', (_name, Component) => {
  it('renders nothing without a job, then the job, without a React error', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const noJob = undefined as unknown as Job;

    const { container, rerender } = render(
      <MemoryRouter><Component job={noJob} jobId="j1" runHistory={[]} /></MemoryRouter>,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<MemoryRouter><Component job={JOB} jobId="j1" runHistory={[]} /></MemoryRouter>);
    expect(container).not.toBeEmptyDOMElement();

    expect(errors).not.toHaveBeenCalled();
  });
});
