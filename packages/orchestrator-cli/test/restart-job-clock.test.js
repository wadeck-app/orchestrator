'use strict';

// `restart-job` waits for the instances it ended to be really gone before it starts the new one, and gives up after a grace
// period. Both are driven here without any real waiting: the wait is on the child's own close (not on a poll), and the grace
// period runs on the clock the scheduler is given (src/time-service.ts), which the test advances by hand.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems, makeHarness, cronJob, settle } = require('./helpers/event-harness');
const { commandsOf } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

describe('restart-job waits on the end of the ended run, and the grace period is the injected clock\'s', () => {
  test('a run that ends when told to: the new run starts without any time having to pass', async () => {
    const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 5000 } });
    const commands = commandsOf(h);
    await commands['trigger-job']({ id: 'job' });

    // No clock advance at all: only the close of the old run can release the wait.
    const reply = await commands['restart-job']({ id: 'job' });

    assert.equal(reply.started, true);
    assert.equal(h.sched.runningCount('job'), 1, 'one copy, not two');
    assert.equal(h.of('job.started').length, 2);
  });

  test('a run that does not end: nothing is started before the grace period, then the restart says what to do', async () => {
    const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 5000 } });
    const commands = commandsOf(h);
    await commands['trigger-job']({ id: 'job' });
    // A process that ignores the stop request.
    h.children[0].kill = function kill() { this.killed = true; return true; };

    let reply = null;
    const pending = commands['restart-job']({ id: 'job' }).then((r) => { reply = r; });
    await settle();
    await h.time.advanceAsync(4999, 1000);
    await settle();
    assert.equal(reply, null, 'still waiting just before the grace period');
    assert.equal(h.spawned.length, 1, 'no second copy while the first is still there');

    await h.time.advanceAsync(1, 1);
    await settle();
    assert.notEqual(reply, null, 'the grace period is over: the restart answers');
    await pending;

    assert.equal(reply.started, false);
    assert.match(reply.reason, /still running 5s after it was told to stop, so no second copy was started/);
    assert.match(reply.reason, /orch kill job and orch trigger job/);
    assert.equal(h.spawned.length, 1);
    assert.equal(h.of('job.restarted')[0].payload.started, false);
  });

  test('the old run ending late, inside the grace period, releases the wait at that moment', async () => {
    const h = makeHarness([cronJob()], { exits: [undefined], scheduler: { restartGraceMs: 5000 } });
    const commands = commandsOf(h);
    await commands['trigger-job']({ id: 'job' });
    h.children[0].kill = function kill() { this.killed = true; return true; };

    let reply = null;
    const pending = commands['restart-job']({ id: 'job' }).then((r) => { reply = r; });
    await settle();
    await h.time.advanceAsync(3000, 1000);
    assert.equal(reply, null);
    h.children[0].exit(143);
    await pending;

    assert.equal(reply.started, true);
    assert.equal(h.sched.runningCount('job'), 1);
  });
});
