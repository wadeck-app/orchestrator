'use strict';
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// We test EventPublisher by monkey-patching global fetch
describe('EventPublisher', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  it('publishes an event via fetch POST', async () => {
    let capturedUrl, capturedBody;
    global.fetch = (url, options) => {
      capturedUrl = url;
      capturedBody = JSON.parse(options.body);
      return Promise.resolve({ ok: true });
    };

    const { EventPublisher } = await import('../dist/event-publisher.js');
    const pub = new EventPublisher();
    pub.publish('job.started', { jobId: 'test-job', label: 'Test Job' });

    // fetch is fire-and-forget, give it a tick
    await new Promise(r => setTimeout(r, 10));

    assert.equal(capturedUrl, 'http://localhost:47910/push');
    assert.equal(capturedBody.event, 'job.started');
    assert.equal(capturedBody.payload.jobId, 'test-job');

    global.fetch = originalFetch;
  });

  it('does not throw when fetch rejects (queue unavailable)', async () => {
    global.fetch = () => Promise.reject(new Error('ECONNREFUSED'));

    const { EventPublisher } = await import('../dist/event-publisher.js');
    const pub = new EventPublisher();

    // Must not throw
    assert.doesNotThrow(() => pub.publish('job.failed', { jobId: 'x', label: 'X' }));
    await new Promise(r => setTimeout(r, 20)); // wait for promise rejection to settle

    global.fetch = originalFetch;
  });
});
