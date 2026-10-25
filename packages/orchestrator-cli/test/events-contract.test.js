'use strict';

// The properties an agent waiting for a job relies on, checked on EVERY way a run can start, end or be refused (the
// scenarios of helpers/event-scenarios.js):
//
//   TERMINAL EXCLUSIVITY  exactly one of job.completed | job.failed | job.skipped | job.killed_manual per run, after its
//                         job.started, and none for a run still going. Counted against the scheduler's OWN channels
//                         ('job-finished', 'job-skipped', the state), not against the events: the test must not agree
//                         with a bug by construction.
//   CATALOG TRUTH         the `terminal` and `outcome` flags of src/event-catalog.ts say what the scenarios observed, and
//                         every event of the catalog is produced by at least one scenario (a new event without a scenario
//                         fails here, so it cannot ship untested).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { assertNoProblems, JOB_TERMINAL, BY_NAME, EVENT_CATALOG } = require('./helpers/event-harness');
const { S } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

const EXEC_TERMINAL = ['exec.completed', 'exec.failed'];
const FOLLOW_UPS = ['job.recovered', 'job.anomaly', 'alert.consecutive_failures', 'alert.retry_exhausted', 'job.restart_scheduled', 'job.restart_abandoned'];
const DURING_THE_RUN = ['job.timed_out', 'job.resource_soft_limit', 'job.resource_hard_limit'];

const observedNames = new Set();
let scenariosRun = 0;

/** What really happened to each ended run, from the scheduler's own signals: success | failure | info. */
function observedOutcomes(h) {
  const outcomes = [];
  for (const ev of h.signals.finished) {
    outcomes.push(ev.cancelledByUser || ev.skipped ? 'info' : ev.exitCode === 0 ? 'success' : 'failure');
  }
  for (const _ of h.signals.refused) { outcomes.push('info'); }
  // A run closed because nothing is left of it (no supervisor, a dead pid) is a failure that nobody saw end.
  for (const _ of h.signals.interrupted) { outcomes.push('failure'); }
  // Start failures are in 'job-finished' (exit code 1); the harness counted them where the start was refused.
  assert.equal(h.signals.finished.filter((ev) => ev.exitCode === 1 && ev.job !== undefined).length >= h.startFailures(), true);
  return outcomes.sort();
}

function checkJobScenario(name, h) {
  const where = `${name}: ${h.names().join(', ')}`;

  // One terminal event per ended run (a refused firing counts as one, it is a job.skipped).
  assert.equal(h.terminals().length, h.runEnds(), `${where} -- ${h.terminals().length} terminal event(s) for ${h.runEnds()} ended run(s)`);

  // The flags of the catalog say what was observed.
  const published = h.terminals().map((e) => BY_NAME.get(e.event).outcome).sort();
  assert.deepEqual(published, observedOutcomes(h), `${where} -- the outcome flags of the catalog disagree with how the runs ended`);
  for (const { event, payload } of h.terminals()) {
    const { outcome } = BY_NAME.get(event);
    if (outcome === 'success') { assert.equal(payload.exitCode, 0, where); }
    if (outcome === 'failure') { assert.ok(Number.isInteger(payload.exitCode) && payload.exitCode !== 0, where); }
  }

  // Order: a terminal event comes after the job.started of its run, the other events where their doc says.
  const running = {};
  const justEnded = {};
  for (const { event, payload } of h.events) {
    const id = payload.jobId;
    if (id === undefined) { continue; }
    running[id] ??= 0;
    if (event === 'job.started') {
      running[id]++;
      justEnded[id] = false;
    } else if (JOB_TERMINAL.includes(event)) {
      const refusal = (event === 'job.skipped' && payload.reason !== 'exitCode')
        || (event === 'job.failed' && payload.exitCode === 1 && payload.durationMs === 0);
      if (!refusal && payload.late !== true) {
        assert.ok(running[id] > 0, `${where} -- ${event} without a run going`);
        running[id]--;
      }
      justEnded[id] = true;
    } else if (FOLLOW_UPS.includes(event)) {
      assert.equal(justEnded[id], true, `${where} -- ${event} must follow the end of a run`);
    } else if (DURING_THE_RUN.includes(event) && payload.late !== true) {
      assert.ok(running[id] > 0, `${where} -- ${event} must happen while the run is going`);
    }
  }
  // A run still going has no terminal event: what the scheduler counts as running is what the events leave open.
  for (const [id, open] of Object.entries(running)) {
    assert.equal(open, h.sched.runningCount(id), `${where} -- ${id}: ${open} run(s) left open by the events, ${h.sched.runningCount(id)} really running`);
  }
}

function checkExecScenario(name, run) {
  const names = run.events.map((e) => e.event);
  const terminals = names.filter((n) => EXEC_TERMINAL.includes(n));
  assert.equal(names[0], 'exec.started', name);
  assert.equal(terminals.length, 1, `${name}: ${names.join(', ')}`);
  const finished = run.manager.get(run.started.runId);
  const observed = finished.exitCode === 0 ? 'success' : 'failure';
  assert.equal(BY_NAME.get(terminals[0]).outcome, observed, `${name}: the catalog flag disagrees with the exit code ${finished.exitCode}`);
}

// What the queue daemon received from the real daemon process, validated like every other event.
function checkDaemonScenario(name, run) {
  const { capturingPublisher } = require('./helpers/event-harness');
  const captured = capturingPublisher();
  for (const e of run.events) { captured.publisher.publish(e.event, e.payload); }
  assert.deepEqual(captured.problems, [], name);
  assert.equal(run.events.filter((e) => e.event === 'daemon.started').length, 1, `${name}: daemon.started once; the daemon said:\n${run.output()}`);
}

describe('every way a run can end publishes exactly one terminal event, and the catalog says what happened', () => {
  for (const [name, scenario] of Object.entries(S)) {
    test(name, async () => {
      const h = await scenario();
      scenariosRun++;
      for (const e of h.events) { observedNames.add(e.event); }
      if (h.kind === 'exec') {
        checkExecScenario(name, h);
      } else if (h.kind === 'daemon') {
        checkDaemonScenario(name, h);
      } else {
        checkJobScenario(name, h);
      }
    });
  }
});

describe('the catalog', () => {
  test('the terminal flags are exactly the contract: four events end a run of a job, two end an exec run', () => {
    const flagged = EVENT_CATALOG.filter((e) => e.terminal === true).map((e) => e.name).sort();
    assert.deepEqual(flagged, [...JOB_TERMINAL, ...EXEC_TERMINAL].sort());
  });

  test('the outcomes: completed and exec.completed succeed, failed and exec.failed fail, skipped and killed_manual are informative', () => {
    const outcome = (n) => BY_NAME.get(n).outcome;
    assert.deepEqual(['job.completed', 'exec.completed'].map(outcome), ['success', 'success']);
    assert.deepEqual(['job.failed', 'exec.failed'].map(outcome), ['failure', 'failure']);
    assert.deepEqual(['job.skipped', 'job.killed_manual'].map(outcome), ['info', 'info']);
    for (const e of EVENT_CATALOG.filter((x) => x.terminal !== true)) {
      assert.equal(e.outcome, undefined, `${e.name} is not terminal, so it has no outcome`);
    }
  });

  test('every event of the catalog is produced by at least one scenario', () => {
    assert.equal(scenariosRun, Object.keys(S).length, 'run after the scenarios above (same file, in order)');
    const never = EVENT_CATALOG.map((e) => e.name).filter((n) => !observedNames.has(n));
    assert.deepEqual(never, [], `no scenario produces: ${never.join(', ')}. Add one to test/helpers/event-scenarios.js.`);
  });
});
