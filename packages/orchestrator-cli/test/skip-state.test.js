'use strict';

// A skipped run has to be invisible to every health measure, not just to the job.failed event.
// Miss one and the job still shows up red somewhere: in the dashboard's failure list, in the systray
// badge, in the consecutive-failure alert, or as a dent in the uptime percentage.
//
// "Invisible" means transparent, not "counts as success": a skip is neither, so it must not repair a
// failing streak either.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { State } = require('../src/state');

function makeState() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-skipstate-'));
  return new State(path.join(dir, 'state.json'));
}

/** Records runs oldest-first, so the last argument ends up as the latest run. */
function record(state, id, runs) {
  let t = Date.parse('2026-09-18T08:00:00.000Z');
  for (const run of runs) {
    const startedAt = new Date(t).toISOString();
    t += 60_000;
    state.record(id, {
      startedAt, finishedAt: new Date(t).toISOString(),
      exitCode: run.exitCode, pid: 1, ...(run.skipped ? { skipped: true } : {}),
    });
  }
}

describe('the failure list ignores skipped runs', () => {
  test('a job whose latest run was skipped is not an unacknowledged failure', () => {
    const state = makeState();
    record(state, 'wa', [{ exitCode: 0 }, { exitCode: 2, skipped: true }]);

    const failures = state.getUnacknowledgedFailures();

    assert.deepEqual(failures, [], 'a skipped run reached the dashboard failure list');
  });

  test('a real failure is still reported', () => {
    const state = makeState();
    record(state, 'wa', [{ exitCode: 2, skipped: true }, { exitCode: 1 }]);

    const failures = state.getUnacknowledgedFailures();

    assert.equal(failures.length, 1);
    assert.equal(failures[0].jobId, 'wa');
  });

  test('acknowledging does not stamp a skipped run', () => {
    const state = makeState();
    record(state, 'wa', [{ exitCode: 2, skipped: true }]);

    state.acknowledgeAll();

    assert.equal(state.get('wa').acknowledgedAt, undefined,
      'a skipped run was acknowledged, which means it was treated as a failure');
  });
});

describe('the consecutive-failure count treats a skip as transparent', () => {
  test('a skip does not count as a failure', () => {
    const state = makeState();
    record(state, 'wa', [{ exitCode: 2, skipped: true }, { exitCode: 2, skipped: true }]);

    assert.equal(state.getConsecutiveFailures('wa'), 0);
  });

  test('a skip does not reset a failing streak either', () => {
    const state = makeState();
    // Two real failures with a skip in between: the job is still failing twice in a row.
    record(state, 'wa', [{ exitCode: 1 }, { exitCode: 2, skipped: true }, { exitCode: 1 }]);

    assert.equal(state.getConsecutiveFailures('wa'), 2,
      'the skip broke the streak and would silence the consecutive-failure alert');
  });

  test('a success still resets it', () => {
    const state = makeState();
    record(state, 'wa', [{ exitCode: 1 }, { exitCode: 0 }]);

    assert.equal(state.getConsecutiveFailures('wa'), 0);
  });
});

describe('uptime ignores skipped runs entirely', () => {
  test('skips are not counted as downtime', () => {
    const state = makeState();
    record(state, 'wa', [
      { exitCode: 0 }, { exitCode: 0 }, { exitCode: 0 },
      { exitCode: 2, skipped: true }, { exitCode: 2, skipped: true },
    ]);

    assert.equal(state.getUptimePercent('wa'), 100,
      'skipped runs dragged the uptime down as if the job had failed');
  });

  test('skips are not counted as uptime either', () => {
    const state = makeState();
    record(state, 'wa', [
      { exitCode: 0 }, { exitCode: 1 }, { exitCode: 2, skipped: true }, { exitCode: 0 },
    ]);

    // 3 real runs, 2 of them successful.
    assert.equal(Math.round(state.getUptimePercent('wa')), 67);
  });

  test('a history of nothing but skips has no uptime to report', () => {
    const state = makeState();
    record(state, 'wa', [
      { exitCode: 2, skipped: true }, { exitCode: 2, skipped: true }, { exitCode: 2, skipped: true },
    ]);

    assert.equal(state.getUptimePercent('wa'), null,
      'an uptime figure was invented from runs that never did any work');
  });
});
