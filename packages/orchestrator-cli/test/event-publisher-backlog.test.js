'use strict';

// The publisher sends one event at a time, so a queue that stops answering would make the events pile up in the daemon's
// memory. The backlog is capped (the oldest waiting event is dropped, the drops are logged once when the burst ends) and
// flush() keeps its outer bound. The SDK publisher is a fake the test holds: no network, and the bound runs on a FakeTime.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { EventPublisher } = require('../src/event-publisher');
const { FakeTime } = require('../src/time-service');

const CWD = path.resolve(os.tmpdir(), 'orch-backlog-cwd');

/** A queue whose answers the test gives, one by one. */
function heldQueue() {
  const sent = [];
  const answers = [];
  const queue = {
    publishAndWait: (event) => new Promise((resolve) => { sent.push(event); answers.push(resolve); }),
    flush: async () => {},
  };
  /** Answers the push in flight and lets the next one start. */
  const answer = async (status = 'queued') => {
    answers.shift()({ status });
    for (let i = 0; i < 4; i++) { await new Promise((resolve) => setImmediate(resolve)); }
  };
  return { queue, sent, answer, inFlight: () => answers.length };
}

function make(options = {}) {
  const held = heldQueue();
  const lines = [];
  const time = new FakeTime(Date.UTC(2026, 0, 1));
  const publisher = new EventPublisher('orchestrator', { write: (l) => lines.push(l) }, {
    cwd: CWD, time, createPublisher: () => held.queue, ...options,
  });
  return { publisher, held, lines, time };
}

describe('the backlog of an EventPublisher is bounded', () => {
  test('when full the OLDEST waiting event is dropped, the others keep their order, and one line gives the count', async () => {
    const { publisher, held, lines } = make({ maxPending: 3 });
    for (let i = 1; i <= 6; i++) {
      publisher.publish(`job.e${i}`, { jobId: 'a', seq: i });
    }
    // e1 is in flight; e2..e4 waited; e5 pushed e2 out and e6 pushed e3 out.
    assert.deepEqual(held.sent, ['job.e1']);
    assert.deepEqual(lines, [], 'nothing is said while the burst lasts');

    while (held.inFlight() > 0) { await held.answer(); }

    assert.deepEqual(held.sent, ['job.e1', 'job.e4', 'job.e5', 'job.e6']);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /2 event\(s\) were dropped, oldest first: more than 3 were waiting/);
    assert.match(lines[0], /queue status/);
  });

  test('a burst that fits is delivered whole and says nothing', async () => {
    const { publisher, held, lines } = make({ maxPending: 3 });
    for (let i = 1; i <= 4; i++) {
      publisher.publish(`job.e${i}`, { jobId: 'a' });
    }
    while (held.inFlight() > 0) { await held.answer(); }
    assert.deepEqual(held.sent, ['job.e1', 'job.e2', 'job.e3', 'job.e4']);
    assert.deepEqual(lines, []);
  });

  test('the default cap is 1000 waiting events', async () => {
    const { publisher, held, lines } = make();
    for (let i = 0; i < 1005; i++) {
      publisher.publish('job.x', { jobId: 'a', seq: i });
    }
    while (held.inFlight() > 0) { await held.answer(); }
    // 1 in flight + 1000 waiting; the 4 oldest waiting ones were dropped.
    assert.equal(held.sent.length, 1001);
    assert.match(lines[0], /4 event\(s\) were dropped/);
  });

  test('a second burst is counted on its own, not added to the first', async () => {
    const { publisher, held, lines } = make({ maxPending: 1 });
    for (let i = 0; i < 4; i++) { publisher.publish('job.x', { jobId: 'a' }); }
    while (held.inFlight() > 0) { await held.answer(); }
    for (let i = 0; i < 3; i++) { publisher.publish('job.x', { jobId: 'a' }); }
    while (held.inFlight() > 0) { await held.answer(); }
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\[event-publisher\] 2 event\(s\)/);
    assert.match(lines[1], /^\[event-publisher\] 1 event\(s\)/);
  });
});

describe('flush() keeps its outer bound on a queue that never answers', () => {
  test('it waits for the bound on the injected clock, then gives up, with events still pending', async () => {
    const { publisher, held, time } = make({ flushBoundMs: 8000 });
    publisher.publish('job.x', { jobId: 'a' });
    publisher.publish('job.y', { jobId: 'a' });
    assert.equal(held.inFlight(), 1, 'the queue never answers');

    let settled = false;
    const done = publisher.flush().then(() => { settled = true; });
    await time.advanceAsync(7999, 1000);
    assert.equal(settled, false, 'still waiting just before the bound');

    await time.advanceAsync(1, 1);
    await done;
    assert.equal(settled, true);
  });

  test('it returns as soon as the backlog is sent, without any time passing', async () => {
    const { publisher, held } = make();
    publisher.publish('job.x', { jobId: 'a' });
    publisher.publish('job.y', { jobId: 'a' });
    const done = publisher.flush();
    await held.answer();
    await held.answer();
    await done;
    assert.deepEqual(held.sent, ['job.x', 'job.y']);
  });
});
