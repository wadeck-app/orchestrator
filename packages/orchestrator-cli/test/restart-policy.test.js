'use strict';

// The restart policy of a job (restartOnExit), as pure functions: what the setting means once defaults are applied, which
// settings are refused and what the refusal says, how long to wait before restart number N, and whether a run that just
// ended earns another restart. No scheduler, no clock: the moments are numbers handed in, so nothing here can be flaky.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  RESTART_STRATEGIES, RESTART_DEFAULTS, RESTART_KEYS,
  restartOnExitError, resolveRestartPolicy, restartDelaySeconds, planRestart,
} = require('../src/restart-policy');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('the defaults', () => {
  test('are the ones the help and docs/daemon-config.md state', () => {
    assert.deepEqual(RESTART_DEFAULTS, {
      strategy: 'exponential', initialDelaySeconds: 1, factor: 2, maxDelaySeconds: 30,
      maxRestarts: 10, windowSeconds: 300, stableAfterSeconds: 900,
    });
    assert.deepEqual([...RESTART_STRATEGIES], ['fixed', 'linear', 'exponential']);
  });

  test('`true` means all defaults', () => {
    assert.deepEqual(resolveRestartPolicy(true), {
      strategy: 'exponential', initialDelaySeconds: 1, factor: 2, maxDelaySeconds: 30,
      maxRestarts: 10, windowSeconds: 300, stableAfterSeconds: 900,
    });
  });

  test('absent, null and false mean the job is not restarted', () => {
    for (const off of [undefined, null, false]) {
      assert.equal(resolveRestartPolicy(off), null);
      assert.equal(restartOnExitError(off), null);
    }
  });

  test('a partial object keeps the defaults for the rest', () => {
    const p = resolveRestartPolicy({ initialDelaySeconds: 5, maxRestarts: 3 });
    assert.equal(p.strategy, 'exponential');
    assert.equal(p.initialDelaySeconds, 5);
    assert.equal(p.maxRestarts, 3);
    assert.equal(p.windowSeconds, 300);
    assert.equal(p.stableAfterSeconds, 900);
    assert.equal(p.factor, 2);
    assert.equal(p.maxDelaySeconds, 30);
  });

  test('a linear policy steps by its initial delay unless told otherwise', () => {
    const p = resolveRestartPolicy({ strategy: 'linear', initialDelaySeconds: 2 });
    assert.equal(p.stepSeconds, 2);
    assert.equal(p.factor, undefined);
    assert.equal(resolveRestartPolicy({ strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 5 }).stepSeconds, 5);
  });

  test('a fixed policy has neither a factor, a step nor a ceiling', () => {
    const p = resolveRestartPolicy({ strategy: 'fixed', initialDelaySeconds: 60 });
    assert.equal(p.factor, undefined);
    assert.equal(p.stepSeconds, undefined);
    assert.equal(p.maxDelaySeconds, undefined);
  });
});

describe('what is refused, and what the message tells the user to do', () => {
  const refused = [
    ['a string', 'always', /restartOnExit must be true or an object/],
    ['a number', 5, /restartOnExit must be true or an object/],
    ['an array', [], /restartOnExit must be true or an object/],
    ['an empty object', {}, /restartOnExit is empty.*true/s],
    ['an unknown key', { retries: 3 }, /unknown key "retries".*Keys: strategy, initialDelaySeconds, factor, stepSeconds, maxDelaySeconds, maxRestarts, windowSeconds, stableAfterSeconds/s],
    ['an unknown strategy', { strategy: 'quadratic' }, /restartOnExit\.strategy must be one of fixed, linear, exponential \(got: "quadratic"\)/],
    ['a zero delay', { initialDelaySeconds: 0 }, /restartOnExit\.initialDelaySeconds must be a number above 0 \(got: 0\)/],
    ['a negative delay', { initialDelaySeconds: -1 }, /restartOnExit\.initialDelaySeconds must be a number above 0 \(got: -1\)/],
    ['a delay that is not a number', { initialDelaySeconds: '5' }, /restartOnExit\.initialDelaySeconds must be a number above 0 \(got: "5"\)/],
    ['NaN', { initialDelaySeconds: NaN }, /restartOnExit\.initialDelaySeconds must be a number above 0/],
    ['Infinity', { maxDelaySeconds: Infinity }, /restartOnExit\.maxDelaySeconds must be a number above 0/],
    ['a factor of 1', { factor: 1 }, /restartOnExit\.factor must be a number above 1.*fixed/s],
    ['a factor below 1', { factor: 0.5 }, /restartOnExit\.factor must be a number above 1/],
    ['a zero step', { strategy: 'linear', stepSeconds: 0 }, /restartOnExit\.stepSeconds must be a number above 0 \(got: 0\)/],
    ['zero restarts', { maxRestarts: 0 }, /restartOnExit\.maxRestarts must be a whole number of at least 1 \(got: 0\)/],
    ['a fractional limit', { maxRestarts: 2.5 }, /restartOnExit\.maxRestarts must be a whole number of at least 1/],
    ['a zero window', { windowSeconds: 0 }, /restartOnExit\.windowSeconds must be a whole number of at least 1 \(got: 0\)/],
    ['a negative stable duration', { stableAfterSeconds: -5 }, /restartOnExit\.stableAfterSeconds must be a whole number of at least 1 \(got: -5\)/],
  ];
  for (const [what, value, pattern] of refused) {
    test(what, () => {
      const problem = restartOnExitError(value);
      assert.notEqual(problem, null, `${JSON.stringify(value)} was accepted`);
      assert.match(problem, pattern);
      assert.throws(() => resolveRestartPolicy(value), pattern);
    });
  }

  test('an option the chosen strategy ignores is refused, not silently dropped', () => {
    assert.match(restartOnExitError({ strategy: 'fixed', factor: 3 }), /restartOnExit\.factor only applies to the exponential strategy.*"fixed"/s);
    assert.match(restartOnExitError({ strategy: 'linear', factor: 3 }), /restartOnExit\.factor only applies to the exponential strategy/);
    assert.match(restartOnExitError({ strategy: 'exponential', stepSeconds: 3 }), /restartOnExit\.stepSeconds only applies to the linear strategy/);
    assert.match(restartOnExitError({ stepSeconds: 3 }), /restartOnExit\.stepSeconds only applies to the linear strategy/, 'the default strategy is exponential');
    assert.match(restartOnExitError({ strategy: 'fixed', maxDelaySeconds: 60 }), /restartOnExit\.maxDelaySeconds does not apply to the fixed strategy/);
  });

  test('a first delay above the ceiling says which of the two to change', () => {
    const problem = restartOnExitError({ initialDelaySeconds: 60 });
    assert.match(problem, /initialDelaySeconds \(60\).*maxDelaySeconds \(30, the default\)/s);
    assert.match(problem, /raise maxDelaySeconds|fixed/);
    assert.equal(restartOnExitError({ initialDelaySeconds: 60, maxDelaySeconds: 120 }), null);
    assert.match(restartOnExitError({ initialDelaySeconds: 60, maxDelaySeconds: 20 }), /initialDelaySeconds \(60\).*maxDelaySeconds \(20\)/s);
    assert.equal(restartOnExitError({ strategy: 'fixed', initialDelaySeconds: 60 }), null);
  });

  test('every key it knows is listed by RESTART_KEYS', () => {
    assert.deepEqual([...RESTART_KEYS], ['strategy', 'initialDelaySeconds', 'factor', 'stepSeconds', 'maxDelaySeconds', 'maxRestarts', 'windowSeconds', 'stableAfterSeconds']);
  });
});

describe('the delay before restart number N', () => {
  const delays = (policy, n) => Array.from({ length: n }, (_, i) => restartDelaySeconds(resolveRestartPolicy(policy), i + 1));

  test('fixed: always the initial delay', () => {
    assert.deepEqual(delays({ strategy: 'fixed', initialDelaySeconds: 7 }, 4), [7, 7, 7, 7]);
  });

  test('linear: grows by the step, up to the ceiling', () => {
    assert.deepEqual(delays({ strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 10 }, 5), [2, 5, 8, 10, 10]);
  });

  test('linear without a step grows by the initial delay', () => {
    assert.deepEqual(delays({ strategy: 'linear', initialDelaySeconds: 2, maxDelaySeconds: 100 }, 4), [2, 4, 6, 8]);
  });

  test('exponential (the default): doubles, up to the ceiling', () => {
    assert.deepEqual(delays(true, 8), [1, 2, 4, 8, 16, 30, 30, 30]);
  });

  test('exponential with another factor and first delay', () => {
    assert.deepEqual(delays({ initialDelaySeconds: 2, factor: 3, maxDelaySeconds: 100 }, 5), [2, 6, 18, 54, 100]);
  });

  test('fractional delays are kept', () => {
    assert.deepEqual(delays({ initialDelaySeconds: 0.5, factor: 2, maxDelaySeconds: 3 }, 5), [0.5, 1, 2, 3, 3]);
  });

  test('a huge attempt number stays at the ceiling and never becomes Infinity or NaN', () => {
    const p = resolveRestartPolicy(true);
    assert.equal(restartDelaySeconds(p, 5000), 30);
    const lin = resolveRestartPolicy({ strategy: 'linear', initialDelaySeconds: 1, maxDelaySeconds: 20 });
    assert.equal(restartDelaySeconds(lin, 1e9), 20);
  });

  test('an attempt below 1 is a bug of the caller and says so', () => {
    assert.throws(() => restartDelaySeconds(resolveRestartPolicy(true), 0), /attempt must be a whole number of at least 1/);
  });
});

describe('planRestart: whether a run that just ended earns another restart', () => {
  // 3 restarts in 60 s; backoff reset after 120 s of stable running.
  const policy = resolveRestartPolicy({ strategy: 'fixed', initialDelaySeconds: 5, maxRestarts: 3, windowSeconds: 60, stableAfterSeconds: 120 });
  const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);

  /** A run that lasted `lastedMs` and ended at `endedAtMs`. */
  const ended = (endedAtMs, lastedMs = SECOND) => ({ nowMs: endedAtMs, startedAtMs: endedAtMs - lastedMs, endedAtMs });

  test('the first exit: restart number 1 after the initial delay', () => {
    const plan = planRestart(policy, undefined, ended(T0));
    assert.equal(plan.action, 'restart');
    assert.equal(plan.attempt, 1);
    assert.equal(plan.delaySeconds, 5);
    assert.equal(plan.restartsInWindow, 1);
    assert.equal(plan.stable, false);
  });

  test('the state it returns is the input of the next exit', () => {
    let state;
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const plan = planRestart(policy, state, ended(T0 + i * 10 * SECOND));
      assert.equal(plan.action, 'restart');
      seen.push([plan.attempt, plan.restartsInWindow]);
      state = plan.state;
    }
    assert.deepEqual(seen, [[1, 1], [2, 2], [3, 3]]);
  });

  test('a restart over the limit within the window is refused: the job is given up on', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = planRestart(policy, state, ended(T0 + i * 10 * SECOND)).state;
    }
    const plan = planRestart(policy, state, ended(T0 + 30 * SECOND));
    assert.equal(plan.action, 'abandon');
    assert.equal(plan.cause, 'limit');
    assert.equal(plan.restartsInWindow, 3);
    assert.equal(plan.attempts, 3);
  });

  test('the window slides: restarts older than the window no longer count', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = planRestart(policy, state, ended(T0 + i * 10 * SECOND)).state;
    }
    // The first restart (T0) leaves the window at T0 + 60 s; at T0 + 61 s only two are left.
    const plan = planRestart(policy, state, ended(T0 + 61 * SECOND));
    assert.equal(plan.action, 'restart');
    assert.equal(plan.restartsInWindow, 3);
    // Attempts keep counting: only a stable run resets the backoff.
    assert.equal(plan.attempt, 4);
  });

  test('exactly at the edge of the window the old restart has left (the window is the last windowSeconds, end excluded)', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = planRestart(policy, state, ended(T0 + i * 10 * SECOND)).state;
    }
    assert.equal(planRestart(policy, state, ended(T0 + 59 * SECOND)).action, 'abandon');
    assert.equal(planRestart(policy, state, ended(T0 + 60 * SECOND)).action, 'restart');
  });

  test('a run that stayed up for the stable duration clears the backoff and the window', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = planRestart(policy, state, ended(T0 + i * 10 * SECOND)).state;
    }
    // Would be refused (3 in the window), but this run lived 120 s: it starts over.
    const plan = planRestart(policy, state, ended(T0 + 40 * SECOND, 120 * SECOND));
    assert.equal(plan.action, 'restart');
    assert.equal(plan.stable, true);
    assert.equal(plan.attempt, 1);
    assert.equal(plan.restartsInWindow, 1);
  });

  test('a run one millisecond short of the stable duration does not reset anything', () => {
    let state;
    for (let i = 0; i < 3; i++) {
      state = planRestart(policy, state, ended(T0 + i * 10 * SECOND)).state;
    }
    const plan = planRestart(policy, state, ended(T0 + 40 * SECOND, 120 * SECOND - 1));
    assert.equal(plan.action, 'abandon');
  });

  test('the backoff climbs with the attempt number', () => {
    const expo = resolveRestartPolicy({ maxRestarts: 100, windowSeconds: 3600 });
    let state;
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const plan = planRestart(expo, state, ended(T0 + i * SECOND));
      delays.push(plan.delaySeconds);
      state = plan.state;
    }
    assert.deepEqual(delays, [1, 2, 4, 8, 16, 30]);
  });

  test('after a stable run the backoff starts from the initial delay again', () => {
    const expo = resolveRestartPolicy({ maxRestarts: 100, windowSeconds: 3600 });
    let state;
    for (let i = 0; i < 5; i++) {
      state = planRestart(expo, state, ended(T0 + i * SECOND)).state;
    }
    const plan = planRestart(expo, state, ended(T0 + 20 * MINUTE, 16 * MINUTE));
    assert.equal(plan.delaySeconds, 1);
    assert.equal(plan.attempt, 1);
  });

  test('a state seeded from a restarted run (the daemon forgot) continues the backoff instead of starting over', () => {
    const expo = resolveRestartPolicy({ maxRestarts: 100, windowSeconds: 3600 });
    const plan = planRestart(expo, undefined, { ...ended(T0), seedAttempt: 3 });
    assert.equal(plan.attempt, 4);
    assert.equal(plan.delaySeconds, 8);
  });

  test('the seed does not outlive a stable run', () => {
    const expo = resolveRestartPolicy({ maxRestarts: 100, windowSeconds: 3600 });
    const plan = planRestart(expo, undefined, { ...ended(T0, 20 * MINUTE), seedAttempt: 3 });
    assert.equal(plan.attempt, 1);
  });

  test('the input state is not modified', () => {
    const state = { attempt: 2, restarts: [T0 - SECOND] };
    const copy = JSON.parse(JSON.stringify(state));
    planRestart(policy, state, ended(T0));
    assert.deepEqual(state, copy);
  });

  test('the default policy (10 restarts in 5 minutes) gives up on a crash loop after 10 restarts and never on a slow one', () => {
    const def = resolveRestartPolicy(true);
    // Crash loop: the process dies the instant it is started; the delays 1, 2, 4, 8, 16, 30, 30, ... add up.
    let state;
    let now = T0;
    let restarts = 0;
    for (;;) {
      const plan = planRestart(def, state, ended(now, 100));
      if (plan.action === 'abandon') { break; }
      restarts++;
      state = plan.state;
      now += plan.delaySeconds * SECOND;
      assert.ok(restarts <= 11, 'never gave up');
    }
    assert.equal(restarts, 10);
    // One exit every 10 minutes is a job that is doing its work, whatever the exit code.
    state = undefined;
    for (let i = 0; i < 50; i++) {
      const plan = planRestart(def, state, ended(T0 + i * 10 * MINUTE, 9 * MINUTE));
      assert.equal(plan.action, 'restart', `exit ${i}`);
      state = plan.state;
    }
  });
});
