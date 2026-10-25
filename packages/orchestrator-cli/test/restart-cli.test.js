'use strict';

// `orch add` / `orch edit` flags of the restart policy: --restart-on-exit and its options. Same harness as
// job-field-flags.test.js: runCli with a fake daemon, so what is asserted is what would be sent, and what the user is told
// when the command is refused before anything is sent.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

async function run(argv, jobs = {}) {
  const calls = [];
  const deps = {
    send: async (command, payload) => {
      calls.push({ command, payload });
      if (command === 'get-job') {
        return jobs[payload.id] ?? null;
      }
      return {};
    },
    startDaemon: async () => {},
    configDir: '/tmp/orch-test',
  };
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let exitCode = 0;
  let stderr = '';
  let stdout = '';
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
  return { calls, exitCode, stderr, stdout };
}

const ADD = ['add', 'startup', 'web', '--command', 'node server.js', '--timeout', '0'];
const sentJob = (calls) => calls.find((c) => c.command === 'add-job').payload;
const sentUpdates = (calls) => calls.find((c) => c.command === 'edit-job').payload;

describe('orch add', () => {
  test('--restart-on-exit alone: restartOnExit is true (all defaults)', async () => {
    const { calls, exitCode } = await run([...ADD, '--restart-on-exit']);
    assert.equal(exitCode, 0);
    assert.equal(sentJob(calls).restartOnExit, true);
  });

  test('every option has a flag, and they build the object', async () => {
    const { calls, exitCode, stderr } = await run([
      ...ADD, '--restart-on-exit', '--restart-strategy', 'linear', '--restart-delay', '2', '--restart-step', '3',
      '--restart-max-delay', '20', '--restart-max', '5', '--restart-window', '120', '--restart-stable-after', '600',
    ]);
    assert.equal(exitCode, 0, stderr);
    assert.deepEqual(sentJob(calls).restartOnExit, {
      strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 20, maxRestarts: 5, windowSeconds: 120, stableAfterSeconds: 600,
    });
  });

  test('the exponential factor', async () => {
    const { calls } = await run([...ADD, '--restart-on-exit', '--restart-factor', '1.5']);
    assert.deepEqual(sentJob(calls).restartOnExit, { factor: 1.5 });
  });

  test('without the flag, nothing about restarts is sent', async () => {
    const { calls } = await run(ADD);
    assert.equal('restartOnExit' in sentJob(calls), false);
  });

  test('an option without --restart-on-exit is refused, saying what to add', async () => {
    const { calls, exitCode, stderr } = await run([...ADD, '--restart-delay', '5']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /--restart-delay.*needs --restart-on-exit/s);
    assert.equal(calls.length, 0);
  });

  const refused = [
    ['a zero delay', ['--restart-delay', '0'], /restartOnExit\.initialDelaySeconds must be a number above 0 \(got: 0\).*\(flag: --restart-delay\)/s],
    ['a negative limit', ['--restart-max', '-1'], /restartOnExit\.maxRestarts must be a whole number of at least 1 \(got: -1\).*\(flag: --restart-max\)/s],
    ['a fractional window', ['--restart-window', '2.5'], /restartOnExit\.windowSeconds must be a whole number.*\(flag: --restart-window\)/s],
    ['an unknown strategy', ['--restart-strategy', 'quadratic'], /restartOnExit\.strategy must be one of fixed, linear, exponential \(got: "quadratic"\).*\(flag: --restart-strategy\)/s],
    ['a delay that is not a number', ['--restart-delay', 'soon'], /--restart-delay expects a number, but got "soon"/],
    ['a delay with no value', ['--restart-delay'], /--restart-delay needs a value/],
    ['a factor of the wrong strategy', ['--restart-strategy', 'fixed', '--restart-factor', '3'], /restartOnExit\.factor only applies to the exponential strategy.*\(flag: --restart-factor\)/s],
    ['a first delay above the ceiling', ['--restart-delay', '60'], /initialDelaySeconds \(60\).*maxDelaySeconds \(30, the default\).*\(flag: --restart-delay\)/s],
  ];
  for (const [what, flags, pattern] of refused) {
    test(`refused before anything is sent: ${what}`, async () => {
      const { calls, exitCode, stderr } = await run([...ADD, '--restart-on-exit', ...flags]);
      assert.equal(exitCode, 4, stderr);
      assert.match(stderr, pattern);
      assert.equal(calls.length, 0);
    });
  }

  test('with a retry list: refused, with both ways out', async () => {
    const { calls, exitCode, stderr } = await run([...ADD, '--restart-on-exit', '--retry-on-exit-codes', '75', '--retry-delays', '5']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /restartOnExit and retryOnExitCodes\/retryDelays cannot be used on the same job/);
    assert.match(stderr, /--unset retryOnExitCodes,retryDelays.*--unset restartOnExit/s);
    assert.equal(calls.length, 0);
  });

  test('an unknown restart flag is refused like any unknown flag', async () => {
    const { exitCode, stderr } = await run([...ADD, '--restart-on-exit', '--restart-forever']);
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /--restart-forever/);
  });
});

describe('orch edit', () => {
  const plain = { id: 'web', type: 'startup', command: 'x' };
  const tuned = { ...plain, restartOnExit: { strategy: 'fixed', initialDelaySeconds: 3 } };

  test('--restart-on-exit turns the defaults on for a job that had none', async () => {
    const { calls, exitCode } = await run(['edit', 'web', '--restart-on-exit'], { web: plain });
    assert.equal(exitCode, 0);
    assert.equal(sentUpdates(calls).updates.restartOnExit, true);
  });

  test('an option is merged into the current setting: the other keys stay', async () => {
    const { calls } = await run(['edit', 'web', '--restart-delay', '9'], { web: tuned });
    assert.deepEqual(sentUpdates(calls).updates.restartOnExit, { strategy: 'fixed', initialDelaySeconds: 9 });
  });

  test('an option on a job that restarts with the defaults starts from the defaults', async () => {
    const { calls } = await run(['edit', 'web', '--restart-max', '3'], { web: { ...plain, restartOnExit: true } });
    assert.deepEqual(sentUpdates(calls).updates.restartOnExit, { maxRestarts: 3 });
  });

  test('--restart-on-exit with options on a job that had none', async () => {
    const { calls } = await run(['edit', 'web', '--restart-on-exit', '--restart-delay', '5'], { web: plain });
    assert.deepEqual(sentUpdates(calls).updates.restartOnExit, { initialDelaySeconds: 5 });
  });

  test('--restart-on-exit alone does not overwrite a tuned setting with the defaults', async () => {
    const { calls } = await run(['edit', 'web', '--restart-on-exit'], { web: tuned });
    assert.deepEqual(sentUpdates(calls).updates.restartOnExit, { strategy: 'fixed', initialDelaySeconds: 3 });
  });

  test('an option on a job that does not restart is refused, saying what to add', async () => {
    const { calls, exitCode, stderr } = await run(['edit', 'web', '--restart-delay', '5'], { web: plain });
    assert.equal(exitCode, 4);
    assert.match(stderr, /web.*does not restart.*--restart-on-exit/s);
    assert.equal(calls.some((c) => c.command === 'edit-job'), false);
  });

  test('a merge that does not hold together is refused with the flag, and how to start over', async () => {
    const { calls, exitCode, stderr } = await run(['edit', 'web', '--restart-factor', '3'], { web: tuned });
    assert.equal(exitCode, 4);
    assert.match(stderr, /restartOnExit\.factor only applies to the exponential strategy/);
    assert.match(stderr, /--unset restartOnExit/);
    assert.equal(calls.some((c) => c.command === 'edit-job'), false);
  });

  test('an unknown job is reported like everywhere else', async () => {
    const { exitCode, stderr } = await run(['edit', 'ghost', '--restart-on-exit'], {});
    assert.equal(exitCode, 3);
    assert.match(stderr, /Job not found: "ghost"/);
  });

  test('a job with a retry list cannot get a restart policy, and the message names the fix', async () => {
    const { exitCode, stderr } = await run(['edit', 'web', '--restart-on-exit'], { web: { ...plain, retryOnExitCodes: [75], retryDelays: [5] } });
    assert.equal(exitCode, 4);
    assert.match(stderr, /cannot be used on the same job/);
    assert.match(stderr, /orch edit web --unset retryOnExitCodes,retryDelays/);
  });

  test('--unset restartOnExit turns the policy off', async () => {
    const { calls, exitCode } = await run(['edit', 'web', '--unset', 'restartOnExit']);
    assert.equal(exitCode, 0);
    assert.deepEqual(sentUpdates(calls).unset, ['restartOnExit']);
  });

  test('changing and clearing it in one command is refused', async () => {
    const { exitCode, stderr } = await run(['edit', 'web', '--restart-on-exit', '--unset', 'restartOnExit'], { web: plain });
    assert.equal(exitCode, 4);
    assert.match(stderr, /restartOnExit/);
  });

  test('an edit that does not mention restarts does not fetch or send anything about them', async () => {
    const { calls } = await run(['edit', 'web', '--label', 'Web']);
    assert.deepEqual(calls.map((c) => c.command), ['edit-job']);
    assert.equal('restartOnExit' in sentUpdates(calls).updates, false);
  });
});

describe('orch kill', () => {
  const job = { web: { id: 'web' } };

  test('says when it cancelled a pending restart of a job that was not running', async () => {
    const calls = [];
    const deps = {
      send: async (command) => { calls.push(command); return command === 'get-job' ? { id: 'web' } : { killed: false, count: 0, cancelledRestart: true }; },
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    };
    const origLog = console.log;
    let out = '';
    console.log = (m) => { out += `${m}\n`; };
    try {
      await runCli(['kill', 'web'], deps);
    } finally {
      console.log = origLog;
    }
    assert.match(out, /Job "web" is not running; its pending restart was cancelled\./);
    assert.ok(job);
  });
});
