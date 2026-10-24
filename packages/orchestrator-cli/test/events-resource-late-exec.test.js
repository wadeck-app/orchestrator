'use strict';

// Three families of events that need more than a fake child: the resource limits (a real short process, a sampler the test
// controls), a run learned about after a daemon restart (the run folder a supervisor leaves behind), and `orch exec`
// (the real ExecManager over a real short process).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems, capturingPublisher, track } = require('./helpers/event-harness');
const { S, untilTrue } = require('./helpers/event-scenarios');
const { ExecManager } = require('../src/exec-manager');

afterEach(assertNoProblems);

describe('job.resource_soft_limit', () => {
  test('is published once per run when the soft budget is exceeded, nothing is killed, the run ends with job.completed', async () => {
    const h = await S.resourceSoft();
    assert.deepEqual(h.names(), ['job.started', 'job.resource_soft_limit', 'job.completed']);
    assert.deepEqual(h.of('job.resource_soft_limit')[0].payload, {
      jobId: 'res', label: 'Res', cpuPct: 20, ramMb: 200, softThreshold: { cpuPct: 15, ramMb: 150 },
    });
  });

  test('is not published when the budget is not exceeded (enforce: off checks nothing)', async () => {
    const h = await S.resourceOff();
    assert.deepEqual(h.names(), ['job.started', 'job.completed']);
  });
});

describe('job.resource_hard_limit', () => {
  test('enforced: published once when the breach is sustained, then the killed run ends with job.failed', async () => {
    const h = await S.resourceKill();
    assert.deepEqual(h.names(), ['job.started', 'job.resource_soft_limit', 'job.resource_hard_limit', 'job.failed']);
    const { payload } = h.of('job.resource_hard_limit')[0];
    assert.equal(payload.enforced, true);
    assert.equal(payload.consecutiveSamples, 2);
    assert.deepEqual(payload.hardThreshold, { cpuPct: 30, ramMb: 300 });
    assert.notEqual(h.of('job.failed')[0].payload.exitCode, 0);
    assert.equal(h.terminals().length, 1);
  });

  test('enforce: warn: published once per breach with enforced: false, the process is not touched and ends by itself', async () => {
    const h = await S.resourceWarn();
    assert.deepEqual(h.names(), ['job.started', 'job.resource_soft_limit', 'job.resource_hard_limit', 'job.completed']);
    assert.equal(h.of('job.resource_hard_limit')[0].payload.enforced, false);
  });

  test('is not a request to stop: no job.kill_requested, no job.killed_manual, no job.timed_out', async () => {
    const h = await S.resourceKill();
    for (const name of ['job.kill_requested', 'job.killed_manual', 'job.timed_out']) {
      assert.deepEqual(h.of(name), [], name);
    }
  });
});

describe('a run that ended while the daemon was down (policy: always announced, flagged late, with the real end time)', () => {
  const cases = [
    ['completed', S.lateCompleted, ['job.completed']],
    ['failed', S.lateFailed, ['job.failed']],
    ['skipped by a skip code', S.lateSkipCode, ['job.skipped']],
    ['killed on request', S.lateKilledManual, ['job.killed_manual']],
    ['timed out', S.lateTimeout, ['job.timed_out', 'job.failed']],
  ];
  for (const [what, scenario, expected] of cases) {
    test(`${what}: ${expected.join(' then ')}, each flagged late with the time the run really ended, and no job.started`, async () => {
      const h = await scenario();
      assert.deepEqual(h.names(), expected);
      for (const e of h.events) {
        assert.equal(e.payload.late, true, e.event);
        assert.equal(e.payload.finishedAt, h.left.finishedAt, e.event);
      }
      assert.equal(h.terminals().length, 1, 'one terminal event for the one run');
    });
  }

  test('is announced once: finding the run folder again does not publish a second time', async () => {
    const h = await S.lateFailed();
    const before = h.names();
    await h.sched.recoverRuns();
    assert.deepEqual(h.names(), before);
  });

  test('an end that is not late carries no late flag (the daemon saw it)', async () => {
    const h = await S.failure();
    assert.equal(h.of('job.failed')[0].payload.late, undefined);
    assert.equal(h.of('job.failed')[0].payload.finishedAt, undefined);
  });
});

describe('exec.started / exec.completed / exec.failed', () => {
  const sameRun = (run) => {
    const ids = new Set(run.events.map((e) => e.payload.runId));
    assert.equal(ids.size, 1, `all the events of a run share its runId: ${[...ids].join(', ')}`);
    assert.equal([...ids][0], run.started.runId);
  };

  test('exit 0: exec.started then exec.completed, once each, same runId, with the command, label and pid', async () => {
    const run = await S.execSuccess();
    assert.deepEqual(run.events.map((e) => e.event), ['exec.started', 'exec.completed']);
    sameRun(run);
    const [started, completed] = run.events.map((e) => e.payload);
    assert.ok(Number.isInteger(started.pid) && started.pid > 0, JSON.stringify(started));
    assert.equal(started.label, 'build');
    assert.match(started.command, /exec\.js/);
    assert.equal(completed.exitCode, 0);
    assert.ok(Number.isInteger(completed.durationMs) && completed.durationMs >= 0);
  });

  test('non-zero exit: exec.failed with that code, instead of exec.completed', async () => {
    const run = await S.execFailure();
    assert.deepEqual(run.events.map((e) => e.event), ['exec.started', 'exec.failed']);
    sameRun(run);
    assert.equal(run.events[1].payload.exitCode, 3);
  });

  test('a run killed with `orch exec` kill ends with exec.failed, once', async () => {
    const run = await S.execKilled();
    assert.deepEqual(run.events.map((e) => e.event), ['exec.started', 'exec.failed']);
    assert.equal(run.manager.get(run.started.runId).status, 'killed');
  });

  test('a run that exceeds its timeout ends with exec.failed, once', async () => {
    const run = await S.execTimeout();
    assert.deepEqual(run.events.map((e) => e.event), ['exec.started', 'exec.failed']);
    assert.equal(run.manager.get(run.started.runId).status, 'killed');
  });

  test('the timeout is the injected clock\'s: still running just before it, killed and announced as failed at it', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const { FakeTime } = require('../src/time-service');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-exec-clock-'));
    const script = path.join(dir, 'exec.js');
    fs.writeFileSync(script, "console.log('ready'); setInterval(() => {}, 1000);");
    const captured = capturingPublisher();
    track({ events: captured.events, problems: captured.problems });
    const time = new FakeTime(Date.now());
    const manager = new ExecManager(dir, captured.publisher, { time });
    const { runId } = manager.fireExec(`"${process.execPath}" "${script}"`, { timeout: 2 });

    await untilTrue(() => manager.get(runId).logs.includes('ready'));
    time.advance(1999);
    assert.equal(manager.get(runId).status, 'running');
    assert.deepEqual(captured.events.map((e) => e.event), ['exec.started']);
    time.advance(1);
    await captured.when((e) => e.event === 'exec.failed');

    assert.equal(manager.get(runId).status, 'killed');
    assert.equal(captured.events.filter((e) => e.event === 'exec.failed').length, 1);
    assert.equal(captured.events[1].payload.durationMs, 2000, 'the duration is measured on the same clock');
  });

  test('two runs have two runIds and one terminal event each', async () => {
    const a = await S.execSuccess();
    const b = await S.execFailure();
    assert.notEqual(a.started.runId, b.started.runId);
    for (const run of [a, b]) {
      assert.equal(run.events.filter((e) => e.event === 'exec.completed' || e.event === 'exec.failed').length, 1);
    }
  });

  test('a run without a label still validates (the label is optional)', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-exec-nolabel-'));
    const script = path.join(dir, 'exec.js');
    fs.writeFileSync(script, 'process.exit(0);');
    const captured = capturingPublisher();
    track({ events: captured.events, problems: captured.problems });
    const manager = new ExecManager(dir, captured.publisher, {});
    manager.fireExec(`"${process.execPath}" "${script}"`);
    await captured.when((e) => e.event === 'exec.completed' || e.event === 'exec.failed');
    assert.deepEqual(captured.events.map((e) => e.event), ['exec.started', 'exec.completed']);
    assert.equal(captured.events[0].payload.label, undefined);
  });

  test('exec events are not job events: a job run publishes no exec.*', async () => {
    const h = await S.success();
    assert.deepEqual(h.names().filter((n) => n.startsWith('exec.')), []);
  });
});
