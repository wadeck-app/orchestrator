'use strict';

// A job that is already running must be able to refuse a new instance of itself.
//
// Until now nothing in the scheduler knew whether a job was running: the only guard was inside the
// scrapers themselves (a lock, exit code 2), so the second instance was spawned, took the lock, and
// was classified as "skipped" only after the fact. `maxConcurrency` moves the decision to where the
// firing is decided.
//
// A refusal is an outcome, not a failure -- and it must NOT leave anything a reader could mistake for
// the newest run: the dashboard's "is it running" reads the history entry with the latest startedAt,
// and the live log follows the newest file. A skip written as a run would flip a running job to
// "Ended" and drag the live tail away from its output.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime }  = require('../src/time-service');
const { runCli }    = require('../src/cli');

const JOB = {
  id: 'j', type: 'cron', schedule: '0 8 * * *', command: 'node -v',
  enabled: true, triggerMode: 'fire-and-forget', maxConcurrency: 1,
};

function makeEnv(jobs, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-maxc-'));
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state    = new State(path.join(dir, 'state.json'));
  registry.load();
  for (const job of jobs) registry.add(job);
  const events   = [];
  const children = [];
  const sched = new Scheduler(registry, state, {
    // A child that only ends when the test says so: "still running" has to be a state we can hold.
    spawn: () => {
      const child = new EventEmitter();
      child.pid = 5000 + children.length;
      children.push(child);
      return child;
    },
    liveness: async () => false,
    sampleUsage: async () => null,
    configDir: dir,
    eventPublisher: { publish: (event, payload) => events.push({ event, payload }) },
    ...extra,
  });
  return { sched, state, registry, events, children, dir };
}

const finish = (child, code = 0) => child.emit('close', code);
const skips  = (events) => events.filter((e) => e.event === 'job.skipped');
const logsOf = (dir, id) => {
  const d = path.join(dir, 'logs', 'jobs', id);
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

describe('a scheduled firing at the limit', () => {
  // The queue event never reached the audit trail; the scheduler's own 'job-skipped' is what the audit listens to.
  test('is announced on the scheduler too, which is what feeds the audit trail', async () => {
    const { sched, registry, children } = makeEnv([JOB]);
    const announced = [];
    sched.on('job-skipped', (ev) => announced.push(ev));
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    assert.equal(announced.length, 1);
    assert.equal(announced[0].id, 'j');
    assert.equal(announced[0].reason, 'concurrency');
    assert.equal(announced[0].running, 1);
    assert.equal(announced[0].maxConcurrency, 1);
    finish(children[0]);
  });

  test('is refused while the limit is reached, and says why', async () => {
    const { sched, registry, children, events } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    assert.equal(children.length, 1, 'a second instance was started on top of the first');
    const [skip] = skips(events);
    assert.ok(skip, 'the refusal left no event');
    assert.equal(skip.payload.jobId, 'j');
    assert.equal(skip.payload.reason, 'concurrency');
    assert.equal(skip.payload.running, 1);
    assert.equal(skip.payload.maxConcurrency, 1);
    finish(children[0]);
  });

  test('does not disturb the run history: the run in flight stays the newest entry', async () => {
    const { sched, registry, state, children } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    const entry = state.get('j');
    assert.equal(entry.finishedAt, undefined, 'the refusal closed or replaced the run in flight');
    assert.equal(entry.skipped, undefined, 'the refusal became the newest run in the history');
    assert.equal(entry.pid, children[0].pid);
    finish(children[0]);
  });

  test('does not create a run log of its own, so the live tail stays on the real run', async () => {
    const { sched, registry, children, dir } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    assert.equal(logsOf(dir, 'j').length, 1, 'a second log file would become the newest and hijack the tail');
    finish(children[0]);
  });

  test('is written into the log of the run that is in progress', async () => {
    const { sched, registry, children, dir } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    const [file] = logsOf(dir, 'j');
    const text = fs.readFileSync(path.join(dir, 'logs', 'jobs', 'j', file), 'utf8');
    assert.match(text, /\[job:skipped\] reason=concurrency -- 1 of 1 already running/);
    finish(children[0]);
  });

  test('goes through once the running instance has finished', async () => {
    const { sched, registry, children } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    finish(children[0]);
    await sched._maybeSpawn(job);

    assert.equal(children.length, 2, 'the slot was never released');
    finish(children[1]);
  });

  test('goes through after a failed run too', async () => {
    const { sched, registry, children } = makeEnv([JOB]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    finish(children[0], 1);
    await sched._maybeSpawn(job);

    assert.equal(children.length, 2, 'a failure kept the slot occupied');
    finish(children[1]);
  });
});

describe('the limit is a count, not a flag', () => {
  test('a limit of 2 lets two instances run and refuses the third', async () => {
    const { sched, registry, children, events } = makeEnv([{ ...JOB, maxConcurrency: 2 }]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    assert.equal(children.length, 2);
    assert.equal(skips(events).length, 1);
    children.forEach((c) => finish(c));
  });

  test('without maxConcurrency nothing changes: overlapping firings are not refused', async () => {
    const { maxConcurrency: _unused, ...unlimited } = JOB;
    const { sched, registry, children, events } = makeEnv([unlimited]);
    const job = registry.get('j');

    await sched._maybeSpawn(job);
    await sched._maybeSpawn(job);

    assert.equal(children.length, 2);
    assert.equal(skips(events).length, 0);
    children.forEach((c) => finish(c));
  });

  test('another job is not counted against this one', async () => {
    const other = { ...JOB, id: 'k' };
    const { sched, registry, children } = makeEnv([JOB, other]);

    await sched._maybeSpawn(registry.get('j'));
    await sched._maybeSpawn(registry.get('k'));

    assert.equal(children.length, 2);
    children.forEach((c) => finish(c));
  });
});

describe('orch trigger respects the limit unless forced', () => {
  test('a refused trigger reports it as a result, not an error', async () => {
    const { sched, children, events } = makeEnv([JOB]);
    await sched.trigger('j');

    const result = await sched.trigger('j');

    assert.deepEqual(result, { status: 'already-running', running: 1, maxConcurrency: 1 });
    assert.equal(children.length, 1);
    assert.equal(skips(events)[0].payload.reason, 'concurrency');
    finish(children[0]);
  });

  test('force starts another instance anyway', async () => {
    const { sched, children } = makeEnv([JOB]);
    await sched.trigger('j');

    const result = await sched.trigger('j', { kind: 'manual' }, false, { force: true });

    assert.equal(children.length, 2);
    assert.equal(result.status, 'started');
    assert.equal(result.pid, children[1].pid);
    children.forEach((c) => finish(c));
  });

  test('a refused trigger does not wait for anything, even with wait', async () => {
    const { sched, children } = makeEnv([JOB]);
    await sched.trigger('j');

    // The limit only turns a wait that would never end into a message; it is far above a call that returns, and cleared
    // so that it does not hold the process open.
    let blockedLimit;
    const result = await Promise.race([
      sched.trigger('j', { kind: 'manual' }, true),
      new Promise((_, reject) => { blockedLimit = setTimeout(() => reject(new Error('blocked on a run that was never started')), 30_000); }),
    ]);
    clearTimeout(blockedLimit);

    assert.equal(result.status, 'already-running');
    finish(children[0]);
  });

  test('a refused trigger does not consume a once job', async () => {
    const once = {
      id: 'o', type: 'once', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget',
      delayMs: 3_600_000, scheduledAt: new Date().toISOString(), maxConcurrency: 1,
    };
    const { sched, registry, children } = makeEnv([once]);
    await sched._fire(registry.get('o'), { kind: 'manual' });

    const result = await sched.trigger('o');

    assert.equal(result.status, 'already-running');
    assert.ok(!('consumed' in result), 'a firing that never happened was reported as consuming the job');
    assert.notEqual(registry.get('o').spent, true, 'the once job was spent by a firing that was refused');
    finish(children[0]);
    await sched.stop();
  });

  test('the answer to a normal trigger says what happened', async () => {
    const { sched, children } = makeEnv([{ ...JOB, maxConcurrency: 3 }]);

    const started = await sched.trigger('j');
    const waited  = sched.trigger('j', { kind: 'manual' }, true);
    finish(children[1], 4);
    const finished = await waited;

    assert.equal(started.status, 'started');
    assert.equal(finished.status, 'finished');
    assert.equal(finished.exitCode, 4);
    finish(children[0]);
  });
});

describe('firings that do not come from the schedule honour the limit too', () => {
  test('a dependent job is refused, not started, when it is already at its limit', async () => {
    const parent = { id: 'p', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' };
    const dep    = { id: 'd', type: 'cron', schedule: '0 9 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget', dependsOn: 'p', maxConcurrency: 1 };
    const { sched, registry, children, events } = makeEnv([parent, dep]);
    await sched._fire(registry.get('d'), { kind: 'manual' });
    await sched.trigger('p');

    finish(children[1], 0);

    assert.equal(children.length, 2, 'the dependency started a second instance of a job at its limit');
    const skip = skips(events).find((e) => e.payload.jobId === 'd');
    assert.ok(skip, 'the refused dependency left no trace');
    assert.equal(skip.payload.reason, 'concurrency');
    finish(children[0]);
  });

  test('a retry that finds the job at its limit is recorded and dropped, not retried forever', async () => {
    const time = new FakeTime();
    const retrying = { ...JOB, retryOnExitCodes: [3], retryDelays: [1] };
    const { sched, children, events } = makeEnv([retrying], { time });
    await sched.trigger('j');
    finish(children[0], 3);
    // While the retry waits, somebody starts the job by hand.
    await sched.trigger('j', { kind: 'manual' }, false, { force: true });
    assert.equal(children.length, 2);

    await time.advanceAsync(5_000, 500);
    await time.advanceAsync(60_000, 5_000);

    assert.equal(children.length, 2, 'the retry started a second instance, or kept trying');
    assert.equal(skips(events).filter((e) => e.payload.reason === 'concurrency').length, 1,
      'a refused retry must be reported exactly once');
    finish(children[1]);
    await sched.stop();
  });
});

describe('maxConcurrency as a setting', () => {
  test('the registry refuses what is not a whole number of at least 1, naming field and value', () => {
    for (const bad of [0, -1, 1.5, 'two', NaN]) {
      const { registry } = makeEnv([]);
      assert.throws(
        () => registry.add({ ...JOB, id: 'bad', maxConcurrency: bad }),
        (err) => /maxConcurrency/.test(err.message) && err.message.includes(`got: ${bad}`) && /unset maxConcurrency/.test(err.message),
        `maxConcurrency ${String(bad)} was accepted`,
      );
    }
  });

  test('the registry accepts 1 and larger whole numbers', () => {
    const { registry } = makeEnv([]);
    registry.add({ ...JOB, id: 'one', maxConcurrency: 1 });
    registry.add({ ...JOB, id: 'many', maxConcurrency: 8 });
    assert.equal(registry.get('many').maxConcurrency, 8);
  });

  test('it can be cleared with edit --unset', () => {
    const { registry } = makeEnv([JOB]);
    registry.edit('j', {}, ['maxConcurrency']);
    assert.ok(!('maxConcurrency' in registry.get('j')));
  });
});

async function runWith(argv, result = {}) {
  const calls = [];
  const deps = {
    send: async (command, payload) => { calls.push({ command, payload }); return result; },
    startDaemon: async () => {},
    configDir: '/tmp/orch-test',
  };
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.error = (msg) => { stderr += `${msg}\n`; };
  console.log = (msg) => { stdout += `${msg}\n`; };
  try {
    await runCli(argv, deps);
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
  return { calls, exitCode, stdout, stderr };
}

const ADD = ['add', 'cron', 'j1', '--schedule', '0 8 * * *', '--command', 'node -v'];

describe('--max-concurrency', () => {
  test('edit sets it', async () => {
    const { calls } = await runWith(['edit', 'j1', '--max-concurrency', '2']);
    assert.equal(calls[0].payload.updates.maxConcurrency, 2);
  });

  test('add sets it', async () => {
    const { calls } = await runWith([...ADD, '--max-concurrency', '1']);
    assert.equal(calls[0].payload.maxConcurrency, 1);
  });

  test('a value that is not a whole number is refused before the daemon is contacted', async () => {
    const { calls, exitCode, stderr } = await runWith(['edit', 'j1', '--max-concurrency', 'two']);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /--max-concurrency expects a whole number/);
    assert.equal(calls.length, 0);
  });

  test('--unset maxConcurrency clears it', async () => {
    const { calls } = await runWith(['edit', 'j1', '--unset', 'maxConcurrency']);
    assert.deepEqual(calls[0].payload.unset, ['maxConcurrency']);
  });

  test('--help lists it and --force', async () => {
    const { stdout } = await runWith(['--help']);
    assert.match(stdout, /--max-concurrency <n>/);
    assert.match(stdout, /orch trigger <id> \[--wait\] \[--force\]/);
  });
});

describe('orch trigger output', () => {
  const REFUSED = { status: 'already-running', running: 1, maxConcurrency: 1 };

  test('a refusal is explained and is not an error', async () => {
    const { stdout, exitCode } = await runWith(['trigger', 'j1'], REFUSED);
    assert.equal(exitCode, 0);
    assert.match(stdout, /Job "j1" is already running \(1\/1\); nothing was started\. Use --force to start another instance\./);
  });

  test('--force is sent to the daemon, and only when given', async () => {
    const forced = await runWith(['trigger', 'j1', '--force'], { status: 'started', pid: 9 });
    const plain  = await runWith(['trigger', 'j1'], { status: 'started', pid: 9 });
    assert.equal(forced.calls[0].payload.force, true);
    assert.equal(plain.calls[0].payload.force, undefined);
  });

  test('--json exposes the status', async () => {
    const { stdout } = await runWith(['trigger', 'j1', '--json'], REFUSED);
    assert.deepEqual(JSON.parse(stdout), REFUSED);
  });

  test('a normal trigger prints what it always printed', async () => {
    const { stdout } = await runWith(['trigger', 'j1'], { status: 'started', pid: 123 });
    assert.match(stdout, /Job "j1" triggered \(pid 123\)\./);
  });

  test('--wait on a refusal does not claim the job finished', async () => {
    const { stdout } = await runWith(['trigger', 'j1', '--wait'], REFUSED);
    assert.doesNotMatch(stdout, /finished/);
    assert.match(stdout, /already running/);
  });
});
