'use strict';

// index.ts is the daemon bootstrap: it has no test harness, so the event listeners it registers were
// the one place where a wrong audit event could ship unnoticed. That is where a skipped run was being
// logged as `job.completed`, which the dashboard's audit view draws with a failure icon -- the very
// false alarm the skip logic exists to remove.
//
// The listeners now live in wireAuditEvents() so the mapping can be tested without booting a daemon.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { wireAuditEvents } = require('../src/audit-wiring');

function wire() {
  const scheduler = new EventEmitter();
  const logged = [];
  wireAuditEvents(scheduler, { log: (event, payload) => logged.push({ event, payload }) });
  return { scheduler, logged };
}

const JOB = { label: 'WhatsApp scrape' };

describe('wireAuditEvents maps a finished run to the right audit event', () => {
  test('a normal run is a completion', () => {
    const { scheduler, logged } = wire();

    scheduler.emit('job-finished', { id: 'wa', exitCode: 0, job: JOB });

    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, 'job.completed');
    assert.deepEqual(logged[0].payload, { jobId: 'wa', label: 'WhatsApp scrape', exitCode: 0 });
  });

  test('a failed run is still a completion, with its exit code', () => {
    const { scheduler, logged } = wire();

    scheduler.emit('job-finished', { id: 'wa', exitCode: 1, job: JOB });

    assert.equal(logged[0].event, 'job.completed');
    assert.equal(logged[0].payload.exitCode, 1);
  });

  test('a skipped run is a skip, not a completion', () => {
    const { scheduler, logged } = wire();

    scheduler.emit('job-finished', { id: 'wa', exitCode: 2, job: JOB, skipped: true });

    assert.equal(logged[0].event, 'job.skipped',
      'the audit trail would draw a failure icon for a run that did nothing wrong');
    assert.equal(logged[0].payload.exitCode, 2, 'the real exit code must stay in the trail');
  });

  test('nothing is logged before an event arrives', () => {
    const { logged } = wire();

    assert.deepEqual(logged, []);
  });

  // The audit log is a side channel: it must never be the reason a job run falls over.
  test('a throwing audit sink does not escape into the scheduler', () => {
    const scheduler = new EventEmitter();
    wireAuditEvents(scheduler, { log: () => { throw new Error('disk full'); } });

    assert.doesNotThrow(() => scheduler.emit('job-finished', { id: 'wa', exitCode: 0, job: JOB }));
  });
});
