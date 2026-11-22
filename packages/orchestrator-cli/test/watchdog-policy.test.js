'use strict';

// The crash policy of the Node watchdog (src/watchdog/policy.ts): port of the Go launcher's CrashRestart.
// Pure functions, no clock and no process.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CRASH_POLICY, DELAYS_ENV, WINDOW_ENV, policyFromEnv, recordCrash, describeExit, describeWindow, describeDuration,
} = require('../src/watchdog/policy');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('default policy', () => {
  test('is 2s, 10s, 30s, 3 restarts in 10 minutes', () => {
    assert.deepEqual(DEFAULT_CRASH_POLICY.delaysMs, [2 * SECOND, 10 * SECOND, 30 * SECOND]);
    assert.equal(DEFAULT_CRASH_POLICY.maxRestarts, 3);
    assert.equal(DEFAULT_CRASH_POLICY.windowMs, 10 * MINUTE);
  });

  test('is what an environment without the test-only variables gives', () => {
    assert.deepEqual(policyFromEnv({}), DEFAULT_CRASH_POLICY);
    assert.deepEqual(policyFromEnv({ [DELAYS_ENV]: '', [WINDOW_ENV]: '' }), DEFAULT_CRASH_POLICY);
  });
});

describe('test-only variables', () => {
  test('ORCH_WATCHDOG_DELAYS_MS and ORCH_WATCHDOG_WINDOW_MS replace the delays and the window', () => {
    const policy = policyFromEnv({ [DELAYS_ENV]: '20, 50,100', [WINDOW_ENV]: '5000' });
    assert.deepEqual(policy.delaysMs, [20, 50, 100]);
    assert.equal(policy.windowMs, 5000);
    assert.equal(policy.maxRestarts, 3);
  });

  for (const bad of ['abc', '20,,50', '20,x', '-5', '0', '1.5', '1e3', ' ', '20;50']) {
    test(`a malformed delay list fails loudly and names the variable: "${bad}"`, () => {
      assert.throws(() => policyFromEnv({ [DELAYS_ENV]: bad }), (e) => e.message.includes(DELAYS_ENV) && /Unset ORCH_WATCHDOG_DELAYS_MS/.test(e.message));
    });
  }

  for (const bad of ['abc', '-1', '0', '1.5', '10m']) {
    test(`a malformed window fails loudly and names the variable: "${bad}"`, () => {
      assert.throws(() => policyFromEnv({ [WINDOW_ENV]: bad }), (e) => e.message.includes(WINDOW_ENV) && /Unset ORCH_WATCHDOG_WINDOW_MS/.test(e.message));
    });
  }
});

describe('recordCrash', () => {
  const policy = DEFAULT_CRASH_POLICY;

  test('the first three crashes are restarted after 2s, 10s, 30s; the fourth is not', () => {
    let crashes = [];
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const v = recordCrash(crashes, 1000 + i * 10 * SECOND, policy);
      crashes = v.crashes;
      seen.push([v.count, v.giveUp, v.giveUp ? null : v.delayMs]);
    }
    assert.deepEqual(seen, [[1, false, 2000], [2, false, 10000], [3, false, 30000], [4, true, null]]);
  });

  test('crashes older than the window are forgotten, so a daemon that crashes every 11 minutes is always restarted after 2s', () => {
    let crashes = [];
    for (let i = 0; i < 10; i++) {
      const v = recordCrash(crashes, i * 11 * MINUTE, policy);
      crashes = v.crashes;
      assert.equal(v.count, 1);
      assert.equal(v.giveUp, false);
      assert.equal(v.delayMs, 2 * SECOND);
    }
  });

  test('a crash exactly one window after the previous one no longer counts it (strictly inside the window only)', () => {
    const first = recordCrash([], 0, policy);
    assert.equal(recordCrash(first.crashes, 10 * MINUTE - 1, policy).count, 2);
    assert.equal(recordCrash(first.crashes, 10 * MINUTE, policy).count, 1);
  });

  test('the last delay is reused when there are more allowed restarts than delays', () => {
    const custom = { delaysMs: [SECOND], maxRestarts: 2, windowMs: MINUTE };
    let crashes = [];
    const delays = [];
    for (let i = 0; i < 2; i++) {
      const v = recordCrash(crashes, i * 1000, custom);
      crashes = v.crashes;
      delays.push(v.delayMs);
    }
    assert.deepEqual(delays, [SECOND, SECOND]);
    assert.equal(recordCrash(crashes, 3000, custom).giveUp, true);
  });

  test('does not modify the list it is given', () => {
    const before = [1, 2];
    recordCrash(before, 3, policy);
    assert.deepEqual(before, [1, 2]);
  });
});

describe('wording', () => {
  test('describeExit names what a -1 means', () => {
    assert.equal(describeExit(1), 'node exited with code 1');
    const killed = describeExit(-1);
    for (const want of ['code -1', 'killed by a signal or forcibly terminated', 'OOM']) {
      assert.ok(killed.includes(want), killed);
    }
  });

  test('describeWindow and describeDuration', () => {
    assert.equal(describeWindow(10 * MINUTE), '10 minutes');
    assert.equal(describeWindow(MINUTE), '1 minute');
    assert.equal(describeWindow(5000), '5s');
    assert.equal(describeWindow(1500), '1500ms');
    assert.equal(describeDuration(2000), '2s');
    assert.equal(describeDuration(30000), '30s');
    assert.equal(describeDuration(50), '50ms');
  });
});
