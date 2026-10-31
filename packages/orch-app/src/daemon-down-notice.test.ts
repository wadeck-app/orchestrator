import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageTellsDaemonDown, shouldNotifyLoadFailureFor } from './daemon-down-notice.js';

const page = (name: string): string => fs.readFileSync(path.resolve(__dirname, 'dsl/pages', name), 'utf8');
const down = { source: 'jobs', status: 503, message: 'daemon-not-running', error: new Error('daemon-not-running'), trigger: 'initial' as const };

describe('pageTellsDaemonDown', () => {
  it('the job list carries DaemonStatus, which says the daemon is down and how to start it', () => {
    expect(pageTellsDaemonDown(page('job-list.yaml'))).toBe(true);
  });

  // job-detail binds its run history table to the failure of its source (`loadError`), so the table says it cannot be read.
  it('the job page counts: its run history says it cannot be read', () => {
    expect(pageTellsDaemonDown(page('job-detail.yaml'))).toBe(true);
  });

  it('a RunHistory without loadError does not count', () => {
    expect(pageTellsDaemonDown('sections:\n  - $type: RunHistory\n    entries: $sources.jobData.runHistory\n  - $type: Section\n    title: loadError: $ctx.$sourceErrors.jobData')).toBe(false);
  });

  it.each(['schedule.yaml', 'audit.yaml', 'job-logs.yaml', 'job-form-new.yaml', 'job-form-edit.yaml'])('%s does not', (file) => {
    expect(pageTellsDaemonDown(page(file))).toBe(false);
  });
});

describe('shouldNotifyLoadFailureFor', () => {
  it('drops the generic banner for a down daemon on a page that says it itself', () => {
    expect(shouldNotifyLoadFailureFor(page('job-list.yaml'))(down)).toBe(false);
  });

  it('drops it on the job page too', () => {
    expect(shouldNotifyLoadFailureFor(page('job-detail.yaml'))(down)).toBe(false);
  });

  it('keeps it on a page that does not', () => {
    expect(shouldNotifyLoadFailureFor(page('schedule.yaml'))(down)).toBe(true);
  });

  it('keeps it for any other failure, whatever the page: only the down daemon is said elsewhere', () => {
    const notify = shouldNotifyLoadFailureFor(page('job-list.yaml'));
    expect(notify({ ...down, status: 500, message: 'boom' })).toBe(true);
    expect(notify({ ...down, status: 503, message: 'overloaded' })).toBe(true);
    expect(notify({ ...down, status: undefined, message: 'network error' })).toBe(true);
  });
});
