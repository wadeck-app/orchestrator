'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { Scheduler, summarizeTimers } = require('../src/scheduler');
const { Registry, validateJob } = require('../src/registry');
const { State } = require('../src/state');
const { FakeTime } = require('../src/time-service');

/*
 * A `manual` job is a definition that only runs when someone asks: `orch trigger`, the dashboard button,
 * the API. The scheduler never arms anything for it, so none of the "will not fire" diagnostics apply, and
 * unlike a `once` job it is not consumed by its run.
 */

const dirs = [];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// `realTime`: run logs older than the retention window are pruned as they are opened, and FakeTime starts long ago.
function makeEnv(exitCodes = [0], { realTime = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-manual-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  const time = new FakeTime();
  const spawned = [];
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    ...(realTime ? {} : { time }),
    liveness: async () => false,
    sampleUsage: async () => null,
    spawn: (cmd) => {
      spawned.push(cmd);
      const code = exitCodes[Math.min(spawned.length - 1, exitCodes.length - 1)];
      const child = new EventEmitter();
      child.pid = 4242;
      process.nextTick(() => child.emit('close', code));
      return child;
    },
    eventPublisher: { publish: () => {} },
  });
  return { dir, registry, state, time, spawned, sched };
}

function manualJob(extra = {}) {
  return { id: 'm1', type: 'manual', command: 'echo run', label: 'M', enabled: true, triggerMode: 'fire-and-forget', ...extra };
}

function onceJob(time, extra = {}) {
  return {
    id: 'o1', type: 'once', command: 'echo once', label: 'O', enabled: true, triggerMode: 'fire-and-forget',
    delayMs: HOUR, scheduledAt: new Date(time.now()).toISOString(), ...extra,
  };
}

describe('registry: a manual job has no schedule', () => {
  test('id, type and command are enough, and nothing schedule-shaped is invented', () => {
    const { registry } = makeEnv();
    registry.add({ id: 'm1', type: 'manual', command: 'echo run' });
    const job = registry.get('m1');
    assert.equal(job.type, 'manual');
    for (const field of ['schedule', 'delaySeconds', 'delayMs', 'scheduledAt', 'missedFiring', 'activeFrom', 'activeUntil']) {
      assert.equal(field in job, false, `a manual job was stored with ${field}`);
    }
  });

  const cases = [
    ['schedule', '0 9 * * *'],
    ['delaySeconds', 30],
    ['delayMs', 1000],
    ['scheduledAt', '2026-01-01T00:00:00.000Z'],
    ['missedFiring', 'skip'],
    ['activeFrom', '2026-01-01T00:00:00.000Z'],
    ['activeUntil', '2027-01-01T00:00:00.000Z'],
  ];
  for (const [field, value] of cases) {
    test(`${field} is refused, naming the field and the fix`, () => {
      assert.throws(
        () => validateJob(manualJob({ [field]: value })),
        (e) => e.message.includes(field) && /manual jobs have no schedule/i.test(e.message) && /cron/.test(e.message),
      );
    });
  }

  test('an unknown type error lists manual', () => {
    assert.throws(() => validateJob(manualJob({ type: 'weekly' })), /"manual"/);
  });

  test('the settings that make sense for a triggered run are accepted', () => {
    validateJob(manualJob({
      timeoutSeconds: 10, maxConcurrency: 1, skipExitCodes: [2], retryOnExitCodes: [7], retryDelays: [5],
      description: 'd', env: { A: '1' }, cwd: 'C:/t', triggerMode: 'wait',
      resourceLimits: { enforce: 'warn' }, liveness: { strategy: 'portFile', portFile: 'x' },
    }));
  });

  test('markSpent refuses it', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.throws(() => registry.markSpent('m1'), /not a once job/);
  });
});

describe('registry: changing the type to or from manual', () => {
  test('cron to manual clears the schedule fields and reports them', () => {
    const { registry } = makeEnv();
    registry.add({ id: 'c1', type: 'cron', command: 'echo', schedule: '0 9 * * *', missedFiring: 'catch-up', activeUntil: '2099-01-01T00:00:00.000Z' });

    const cleared = registry.edit('c1', { type: 'manual' });

    assert.deepEqual([...cleared].sort(), ['activeUntil', 'missedFiring', 'schedule']);
    const job = registry.get('c1');
    assert.equal(job.type, 'manual');
    assert.equal(job.schedule, undefined);
    assert.equal(job.missedFiring, undefined);
    assert.equal(job.activeUntil, undefined);
    assert.equal(job.command, 'echo', 'unrelated fields must survive');
  });

  test('startup to manual clears the delay', () => {
    const { registry } = makeEnv();
    registry.add({ id: 's1', type: 'startup', command: 'echo', delaySeconds: 30 });
    assert.deepEqual(registry.edit('s1', { type: 'manual' }), ['delaySeconds']);
    assert.equal(registry.get('s1').delaySeconds, undefined);
  });

  test('a spent once job to manual drops the once state', () => {
    const { registry, time } = makeEnv();
    registry.add(onceJob(time));
    registry.markSpent('o1');
    const cleared = registry.edit('o1', { type: 'manual' });
    assert.deepEqual([...cleared].sort(), ['delayMs', 'scheduledAt', 'spent', 'spentAt']);
    assert.equal(registry.get('o1').spent, undefined);
  });

  test('manual to cron needs a schedule, and says so', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.throws(() => registry.edit('m1', { type: 'cron' }), /schedule/);
    assert.equal(registry.get('m1').type, 'manual', 'a refused edit must change nothing');
    assert.deepEqual(registry.edit('m1', { type: 'cron', schedule: '0 9 * * *' }), []);
    assert.equal(registry.get('m1').type, 'cron');
  });

  test('manual to once stamps the origin of the delay', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    registry.edit('m1', { type: 'once', delayMs: HOUR });
    assert.notEqual(registry.get('m1').scheduledAt, undefined);
  });

  test('editing a manual job without changing its type reports nothing cleared', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.deepEqual(registry.edit('m1', { label: 'X' }), []);
  });

  test('setting a schedule on a manual job without changing the type is refused', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.throws(() => registry.edit('m1', { schedule: '0 9 * * *' }), /manual jobs have no schedule/i);
  });
});

describe('scheduler: nothing is armed for a manual job', () => {
  test('not at daemon start, and not reported as a timer problem', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    await env.sched.start();
    try {
      assert.equal(env.spawned.length, 0, 'a manual job ran at start');
      assert.equal(env.sched.armedTimers, 0, 'a timer was armed for a manual job');
      const row = env.sched.inspectTimers().find((r) => r.jobId === 'm1');
      assert.equal(row.type, 'manual');
      assert.equal(row.armed, null);
      assert.equal(row.problem, null, `a manual job was reported as: ${row.problem}`);
      assert.equal(row.spent, false);
    } finally {
      await env.sched.stop();
    }
  });

  test('not when it is added while the daemon runs', async () => {
    const env = makeEnv();
    await env.sched.start();
    try {
      env.registry.add(manualJob());
      env.sched.scheduleJob(env.registry.get('m1'));
      assert.equal(env.sched.armedTimers, 0);
      assert.equal(env.sched.inspectTimers()[0].problem, null);
    } finally {
      await env.sched.stop();
    }
  });

  test('time passing fires nothing', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    await env.sched.start();
    try {
      await env.time.advanceAsync(30 * DAY, HOUR);
      assert.equal(env.spawned.length, 0);
    } finally {
      await env.sched.stop();
    }
  });

  test('it is not caught up after a downtime, however long', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    // A run recorded a year ago, then the daemon was off: the situation catch-up exists for.
    env.state.record('m1', { startedAt: new Date(env.time.now() - 365 * DAY).toISOString(), exitCode: 0, finishedAt: new Date(env.time.now() - 365 * DAY + 1000).toISOString() });
    await env.sched.start();
    try {
      await env.time.advanceAsync(HOUR, MINUTE);
      assert.equal(env.spawned.length, 0, 'a manual job was caught up');
    } finally {
      await env.sched.stop();
    }
  });

  test('skip-next-firing is a no-op', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    await env.sched.start();
    try {
      env.sched.skipNextFiring('m1');
      assert.equal(env.sched._skippedJobs.size, 0);
      const res = await env.sched.trigger('m1');
      assert.equal(res.status, 'started');
    } finally {
      await env.sched.stop();
    }
  });

  test('the dashboard summary does not count it as a job that should have a timer', () => {
    const summary = summarizeTimers([
      { jobId: 'm1', type: 'manual', enabled: true, armed: null, spent: false, windowState: null, problem: null },
    ]);
    assert.equal(summary.desired, 0);
    assert.equal(summary.armed, 0);
    assert.deepEqual(summary.problems, []);
  });
});

describe('scheduler: a triggered manual job is a normal run', () => {
  test('it runs, keeps its definition, its history, and is not consumed; a once job is', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    env.registry.add(onceJob(env.time));
    await env.sched.start();
    try {
      const first = await env.sched.trigger('m1');
      assert.equal(first.status, 'started');
      assert.equal(first.consumed, undefined, 'a manual trigger reported the job as consumed');
      await new Promise((resolve) => setImmediate(resolve));
      await env.sched.trigger('m1');
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(env.spawned.filter((c) => c === 'echo run').length, 2, 'it did not run each time it was asked');
      const job = env.registry.get('m1');
      assert.notEqual(job, null, 'the manual job was deleted by its run');
      assert.equal(job.spent, undefined);
      assert.equal(job.enabled, true);
      assert.equal(env.state.get('m1').exitCode, 0, 'no run history was kept');

      // The contrast: the same trigger spends a once job.
      const once = await env.sched.trigger('o1');
      assert.equal(once.consumed, true);
      assert.equal(env.registry.get('o1').spent, true);
    } finally {
      await env.sched.stop();
    }
  });

  test('its run writes a log under its id', async () => {
    const env = makeEnv([0], { realTime: true });
    env.registry.add(manualJob());
    await env.sched.start();
    try {
      await env.sched.trigger('m1', { kind: 'manual' }, true);
      const files = [];
      const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); } };
      walk(env.dir);
      assert.ok(files.some((f) => f.includes('m1') && f.endsWith('.log')), `no log for m1 among: ${files.join(', ')}`);
    } finally {
      await env.sched.stop();
    }
  });

  test('a failed triggered run is retried like any other job, then stops', async () => {
    const env = makeEnv([7, 0]);
    env.registry.add(manualJob({ retryOnExitCodes: [7], retryDelays: [60] }));
    await env.sched.start();
    try {
      await env.sched.trigger('m1', { kind: 'manual' }, true);
      assert.equal(env.spawned.length, 1);
      await env.time.advanceAsync(2 * MINUTE, 10_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(env.spawned.length, 2, 'the retry did not run');
      await env.time.advanceAsync(HOUR, MINUTE);
      assert.equal(env.spawned.length, 2, 'it ran again after a successful retry');
    } finally {
      await env.sched.stop();
    }
  });

  test('maxConcurrency still applies to a triggered run', async () => {
    const env = makeEnv();
    env.registry.add(manualJob({ maxConcurrency: 1, triggerMode: 'wait' }));
    env.sched._running.set('m1', 1);
    await env.sched.start();
    try {
      const res = await env.sched.trigger('m1');
      assert.equal(res.status, 'already-running');
    } finally {
      await env.sched.stop();
    }
  });
});

describe('edit-job: a type change that drops fields says so', () => {
  const { makeCommands } = require('../src/commands');

  test('cron to manual disarms the job and the audit trail names what was dropped', () => {
    const { registry, state, dir } = makeEnv();
    registry.add({ id: 'c1', type: 'cron', command: 'echo', schedule: '0 9 * * *' });
    const audited = [];
    const unscheduled = [];
    const scheduled = [];
    const scheduler = {
      scheduleJob: (job) => scheduled.push(job.type), unscheduleJob: (id) => unscheduled.push(id), skipNextFiring: () => {},
    };
    const commands = makeCommands(registry, state, scheduler, dir, undefined, { log: (event, data) => audited.push({ event, data }) });

    const job = commands['edit-job']({ id: 'c1', updates: { type: 'manual' } });

    assert.equal(job.type, 'manual');
    assert.equal(job.schedule, undefined);
    // The scheduler is handed the manual job, whose scheduleJob arms nothing and clears the cron task first.
    assert.deepEqual(scheduled, ['manual']);
    const entry = audited.find((a) => a.event === 'job.edited');
    assert.deepEqual([...entry.data.clearedForType].sort(), ['missedFiring', 'schedule']);
    assert.match(entry.data.note, /dropped .*schedule.*no longer apply/);
  });
});

describe('edit-job into a manual job, on the real scheduler', () => {
  const { makeCommands } = require('../src/commands');

  test('an armed cron job is disarmed: no timer, nothing fires when the old time passes, no timer problem', async () => {
    const env = makeEnv();
    env.registry.add({ id: 'c1', type: 'cron', schedule: '0 9 * * *', command: 'echo cron', enabled: true, triggerMode: 'fire-and-forget' });
    const commands = makeCommands(env.registry, env.state, env.sched, env.dir);
    await env.sched.start();
    try {
      assert.ok(env.sched.armedTimers >= 1, 'the cron job should be armed before the edit');

      commands['edit-job']({ id: 'c1', updates: { type: 'manual' } });

      assert.equal(env.sched.armedTimers, 0, 'the cron timer survived the type change');
      await env.time.advanceAsync(3 * DAY, HOUR);
      assert.equal(env.spawned.length, 0, 'the old schedule still fired');
      const row = env.sched.inspectTimers().find((r) => r.jobId === 'c1');
      assert.equal(row.type, 'manual');
      assert.equal(row.armed, null);
      assert.equal(row.problem, null, `reported as: ${row.problem}`);
    } finally {
      await env.sched.stop();
    }
  });

  test('a switched-off manual job is still run by an explicit trigger (as every such job is), and still arms nothing', async () => {
    const env = makeEnv();
    env.registry.add(manualJob({ enabled: false }));
    await env.sched.start();
    try {
      assert.equal(env.sched.armedTimers, 0);
      const res = await env.sched.trigger('m1');
      assert.equal(res.status, 'started');
      assert.deepEqual(env.spawned, ['echo run']);
    } finally {
      await env.sched.stop();
    }
  });

  test('dry-run of a manual job that declares support runs it with --dry-run; one that does not is refused in words', async () => {
    const env = makeEnv();
    env.registry.add(manualJob({ dryRunSupported: true }));
    env.registry.add(manualJob({ id: 'm2' }));
    await env.sched.start();
    try {
      await env.sched.dryRun('m1');
      assert.deepEqual(env.spawned, ['echo run --dry-run']);
      assert.deepEqual(await env.sched.dryRun('m2'), { error: 'Job "m2" does not declare dryRunSupported: true' });
      assert.equal(env.spawned.length, 1);
    } finally {
      await env.sched.stop();
    }
  });

  test('restart-job on a manual job that is not running just starts it; on a switched-off one it is refused with the fix', async () => {
    const env = makeEnv();
    env.registry.add(manualJob());
    env.registry.add(manualJob({ id: 'm2', enabled: false }));
    const commands = makeCommands(env.registry, env.state, env.sched, env.dir);
    await env.sched.start();
    try {
      const reply = await commands['restart-job']({ id: 'm1' });
      assert.equal(reply.wasRunning, false);
      assert.equal(reply.started, true);
      assert.equal(env.sched.armedTimers, 0, 'a restart must not arm a manual job');
      await assert.rejects(() => commands['restart-job']({ id: 'm2' }), { message: 'Job "m2" is disabled, so it is not restarted. Enable it with `orch enable m2` first.' });
    } finally {
      await env.sched.stop();
    }
  });
});

describe('registry: manual job edge edits', () => {
  test('a type change to manual that also sends a schedule is refused and changes nothing', () => {
    const { registry } = makeEnv();
    registry.add({ id: 'c1', type: 'cron', command: 'echo', schedule: '0 9 * * *' });
    const before = JSON.stringify(registry.get('c1'));

    assert.throws(
      () => registry.edit('c1', { type: 'manual', schedule: '0 9 * * *' }),
      { message: 'Manual jobs have no schedule: "schedule" is not accepted on a manual job. Remove it, or use a cron job (orch add cron) to run on a schedule.' },
    );

    assert.equal(JSON.stringify(registry.get('c1')), before);
  });

  test('manual to startup works and the job gets the startup behaviour (no delay needed)', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.deepEqual(registry.edit('m1', { type: 'startup' }), []);
    assert.equal(registry.get('m1').type, 'startup');
  });

  test('an empty schedule on a manual job is refused, null (nothing) is accepted', () => {
    const { registry } = makeEnv();
    registry.add(manualJob());
    assert.throws(() => registry.edit('m1', { schedule: '' }), /Manual jobs have no schedule: "schedule"/);
    registry.edit('m1', { schedule: null });
    assert.equal(registry.get('m1').type, 'manual');
  });
});

describe('summarizeTimers: a manual row among the others', () => {
  const row = (jobId, over) => ({ jobId, type: 'cron', enabled: true, armed: 'cron', spent: false, windowState: 'active', problem: null, ...over });

  test('desired and armed count only what should have a timer; a manual row changes neither', () => {
    const rows = [
      row('cron-ok', {}),
      row('cron-off', { enabled: false, armed: null }),
      row('once-spent', { type: 'once', armed: null, spent: true }),
      row('startup', { type: 'startup', armed: null }),
      row('cron-expired', { armed: null, windowState: 'expired', problem: 'its active period has ended -- enabled but nothing armed; re-enable it to resume' }),
      row('manual', { type: 'manual', armed: null }),
      row('manual-off', { type: 'manual', armed: null, enabled: false }),
    ];
    const withManual = summarizeTimers(rows);
    const withoutManual = summarizeTimers(rows.filter((r) => r.type !== 'manual'));

    assert.deepEqual(withManual, withoutManual);
    assert.equal(withManual.desired, 1);
    assert.equal(withManual.armed, 1);
    assert.deepEqual(withManual.problems.map((p) => p.jobId), ['cron-expired']);
  });
});
