'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { DeadlineQueue } = require('../src/deadlines');
const { FakeTime } = require('../src/time-service');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function makeQueue() {
  const time = new FakeTime();
  const errors = [];
  const q = new DeadlineQueue(time, (jobId, kind, err) => { errors.push({ jobId, kind, err }); });
  return { time, q, errors };
}

describe('every scheduled moment behind one armed timer', () => {
  /*
   * The promise the whole class exists for. orch is the thing on a machine that owns timers for other
   * applications, so owning a pile of its own was the wrong shape - a cron task per job plus one timer
   * per once job, per window bound, per retry.
   *
   * Asserted on the count, because behaviour would look identical with twenty timers and only the
   * count can notice the regression.
   */
  test('twenty deadlines arm one timer', () => {
    const { time, q } = makeQueue();

    for (let i = 0; i < 20; i++) {
      q.set(`j${i}`, 'cron', time.now() + (i + 1) * HOUR, () => {});
    }

    assert.equal(q.size, 20);
    assert.equal(q.armedTimers, 1, 'one timer per deadline is exactly what this replaces');
  });

  test('nothing outstanding arms nothing', () => {
    const { time, q } = makeQueue();
    q.set('j1', 'cron', time.now() + HOUR, () => {});
    assert.equal(q.armedTimers, 1);

    q.clear('j1', 'cron');

    assert.equal(q.size, 0);
    assert.equal(q.armedTimers, 0, 'a timer is armed with nothing to wait for');
  });

  test('it waits for the earliest, whatever order they arrive in', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('late', 'cron', time.now() + 3 * HOUR, () => fired.push('late'));
    q.set('early', 'cron', time.now() + 1 * HOUR, () => fired.push('early'));
    q.set('middle', 'cron', time.now() + 2 * HOUR, () => fired.push('middle'));

    time.advance(HOUR);
    assert.deepEqual(fired, ['early']);
    time.advance(HOUR);
    assert.deepEqual(fired, ['early', 'middle']);
    time.advance(HOUR);
    assert.deepEqual(fired, ['early', 'middle', 'late']);
    assert.equal(q.armedTimers, 0, 'still armed with nothing left');
  });

  // A deadline added ahead of the armed one has to take over, or the sooner job waits for the later.
  test('a nearer deadline takes over the armed one', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('later', 'cron', time.now() + 5 * HOUR, () => fired.push('later'));

    q.set('sooner', 'once', time.now() + MINUTE, () => fired.push('sooner'));

    time.advance(2 * MINUTE);
    assert.deepEqual(fired, ['sooner'], 'the sooner deadline waited for the later one');
    assert.equal(q.armedTimers, 1, 'the remaining deadline is no longer armed');
  });

  // Several due at the same moment must all run, in due order, on the one wake-up.
  test('everything due on the same wake-up runs, in order', () => {
    const { time, q } = makeQueue();
    const fired = [];
    const at = time.now() + HOUR;
    q.set('a', 'cron', at, () => fired.push('a'));
    q.set('b', 'cron', at, () => fired.push('b'));
    q.set('c', 'window-end', at - 1, () => fired.push('c'));

    time.advance(HOUR);

    assert.deepEqual(fired, ['c', 'a', 'b']);
  });

  /*
   * What a cron firing does: run, then put its next occurrence back. Re-adding the same key must
   * replace rather than collide, and must not be seen as due inside the same drain.
   */
  test('a deadline that re-arms itself keeps firing, once per occurrence', () => {
    const { time, q } = makeQueue();
    let count = 0;
    const arm = () => {
      q.set('c1', 'cron', time.now() + 5 * MINUTE, () => { count++; arm(); });
    };
    arm();

    time.advance(30 * MINUTE);

    assert.equal(count, 6, `fired ${count} times in 30 minutes of 5-minute occurrences`);
    assert.equal(q.armedTimers, 1, 'the next occurrence is not armed');
  });

  test('replacing a deadline drops the moment it replaced', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('j1', 'once', time.now() + HOUR, () => fired.push('old'));
    q.set('j1', 'once', time.now() + 2 * HOUR, () => fired.push('new'));

    time.advance(3 * HOUR);

    assert.deepEqual(fired, ['new'], 'the replaced moment fired too');
  });

  // One job, several kinds: a cron job inside an active period has both, and clearing one by name
  // must not take the other with it.
  test('kinds of the same job are independent', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('c1', 'cron', time.now() + HOUR, () => fired.push('cron'));
    q.set('c1', 'window-end', time.now() + 2 * HOUR, () => fired.push('window-end'));
    assert.equal(q.size, 2);

    q.clear('c1', 'cron');
    time.advance(3 * HOUR);

    assert.deepEqual(fired, ['window-end']);
  });

  test('clearing a job drops every kind it holds', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('c1', 'cron', time.now() + HOUR, () => fired.push('cron'));
    q.set('c1', 'window-end', time.now() + 2 * HOUR, () => fired.push('window-end'));

    q.clear('c1');
    time.advance(3 * HOUR);

    assert.equal(q.size, 0);
    assert.deepEqual(fired, []);
    assert.equal(q.armedTimers, 0);
  });

  // One broken job must not stop the scheduler: the others due on the same wake-up still run, and the
  // failure is reported rather than swallowed.
  test('a callback that throws is reported and the rest still run', () => {
    const { time, q, errors } = makeQueue();
    const fired = [];
    const at = time.now() + HOUR;
    q.set('boom', 'cron', at, () => { throw new Error('nope'); });
    q.set('fine', 'cron', at, () => fired.push('fine'));

    time.advance(HOUR);

    assert.deepEqual(fired, ['fine'], 'a throwing callback stopped the others');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].jobId, 'boom');
    assert.equal(errors[0].kind, 'cron');
  });

  // Past-due work is run rather than skipped, which is what a catch-up at startup relies on.
  test('a deadline already past runs at the next opportunity', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('overdue', 'once', time.now() - DAY, () => fired.push('overdue'));

    time.advance(1);

    assert.deepEqual(fired, ['overdue']);
  });

  // Beyond a timer's 2^31-1 ms ceiling. Handled once here rather than at each call site.
  test('a deadline two months out is not fired immediately', () => {
    const { time, q } = makeQueue();
    const fired = [];
    q.set('far', 'once', time.now() + 60 * DAY, () => fired.push('far'));

    time.advance(HOUR);
    assert.deepEqual(fired, [], 'the runtime delay ceiling clamped it');

    time.advance(60 * DAY);
    assert.deepEqual(fired, ['far']);
  });

  test('clearAll disarms', () => {
    const { time, q } = makeQueue();
    q.set('a', 'cron', time.now() + HOUR, () => {});
    q.set('b', 'once', time.now() + HOUR, () => {});

    q.clearAll();

    assert.equal(q.size, 0);
    assert.equal(q.armedTimers, 0);
  });

  test('list is earliest first, and find answers by job and kind', () => {
    const { time, q } = makeQueue();
    const soon = time.now() + HOUR;
    const later = time.now() + 2 * HOUR;
    q.set('b', 'once', later, () => {});
    q.set('a', 'cron', soon, () => {});

    assert.deepEqual(q.list().map(d => d.jobId), ['a', 'b']);
    assert.equal(q.find('b', 'once').dueAt, later);
    assert.equal(q.find('b', 'cron'), null);
  });
});
