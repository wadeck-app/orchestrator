'use strict';

// `orch restart-job <id>` restarts one job; `orch restart` restarts the DAEMON. The two are one word apart, and
// `orch restart my-job` used to restart the whole daemon and ignore the id, so that is refused with the fix.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

async function run(argv, reply = {}) {
  const calls = [];
  const out = [];
  const err = [];
  let exitCode = 0;
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.log = (m) => { out.push(String(m)); };
  console.error = (m) => { err.push(String(m)); };
  try {
    await runCli(argv, {
      send: async (command, payload) => { calls.push({ command, payload }); return reply; },
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    });
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { calls, out: out.join('\n'), err: err.join('\n'), exitCode };
}

describe('orch restart-job', () => {
  test('sends restart-job with the id', async () => {
    const { calls } = await run(['restart-job', 'srv'], { id: 'srv', wasRunning: true, killed: 1, started: true, pid: 42 });

    assert.deepEqual(calls, [{ command: 'restart-job', payload: { id: 'srv' } }]);
  });

  test('a running job: one sentence with what was ended and the new pid', async () => {
    const { out, exitCode } = await run(['restart-job', 'srv'], { id: 'srv', wasRunning: true, killed: 1, started: true, pid: 42 });

    assert.equal(out, 'Job "srv" restarted (was running, 1 instance ended; new pid 42).');
    assert.equal(exitCode, 0);
  });

  test('several instances ended say how many', async () => {
    const { out } = await run(['restart-job', 'srv'], { id: 'srv', wasRunning: true, killed: 3, started: true, pid: 7 });

    assert.equal(out, 'Job "srv" restarted (was running, 3 instances ended; new pid 7).');
  });

  test('a job that was not running is started and says so', async () => {
    const { out, exitCode } = await run(['restart-job', 'srv'], { id: 'srv', wasRunning: false, killed: 0, started: true, pid: 9 });

    assert.equal(out, 'Job "srv" was not running, started (pid 9).');
    assert.equal(exitCode, 0);
  });

  test('a refused start prints the reason and the fix on stderr and exits 1', async () => {
    const { out, err, exitCode } = await run(['restart-job', 'srv'], {
      id: 'srv', wasRunning: true, killed: 1, started: false, pid: null, skipped: 'liveness',
      reason: 'the liveness check says its target is still alive. Free it, then run: orch trigger srv.',
    });

    assert.equal(out, '');
    assert.equal(err, 'Job "srv" was ended (1 instance) but not started: the liveness check says its target is still alive. Free it, then run: orch trigger srv.');
    assert.equal(exitCode, 1);
  });

  test('a refused start of a job that was not running does not claim it was ended', async () => {
    const { err, exitCode } = await run(['restart-job', 'srv'], {
      id: 'srv', wasRunning: false, killed: 0, started: false, pid: null, skipped: 'concurrency', reason: 'at its limit.',
    });

    assert.equal(err, 'Job "srv" was not started: at its limit.');
    assert.equal(exitCode, 1);
  });

  test('--json prints the daemon\'s answer, and still exits 1 when nothing started', async () => {
    const reply = { id: 'srv', wasRunning: true, killed: 1, started: false, pid: null, skipped: 'liveness', reason: 'r' };
    const { out, err, exitCode } = await run(['restart-job', 'srv', '--json'], reply);

    assert.deepEqual(JSON.parse(out), reply);
    assert.equal(err, '');
    assert.equal(exitCode, 1);
  });

  test('without an id it prints the usage and sends nothing', async () => {
    const { calls, err, exitCode } = await run(['restart-job']);

    assert.deepEqual(calls, []);
    assert.match(err, /Usage: orch restart-job <id>/);
    assert.equal(exitCode, 1);
  });
});

describe('orch restart with a job id', () => {
  test('is refused with the command that was meant, and does not restart the daemon', async () => {
    const { calls, err, exitCode } = await run(['restart', 'srv']);

    assert.deepEqual(calls, [], 'the daemon must not be restarted');
    assert.match(err, /orch restart restarts the daemon/);
    assert.match(err, /orch restart-job srv/);
    assert.equal(exitCode, 1);
  });

  test('without an argument it still restarts the daemon', async () => {
    const { calls, exitCode } = await run(['restart']);

    assert.equal(calls[0].command, 'restart');
    assert.equal(exitCode, 0);
  });
});

describe('the help', () => {
  test('lists restart-job and tells it apart from restart', async () => {
    const { out } = await run(['--help']);

    assert.match(out, /orch restart-job <id>/);
    assert.match(out, /timeout 0|long-running/i);
    assert.match(out, /orch restart\s+Restart the daemon \(not a job: use restart-job <id>\)/);
  });
});

describe('orch restart-job edges', () => {
  test('--json without an id prints the usage on stderr, nothing on stdout, sends nothing and exits 1', async () => {
    const { calls, out, err, exitCode } = await run(['restart-job', '--json']);

    assert.deepEqual(calls, []);
    assert.equal(out, '');
    assert.equal(err, 'Usage: orch restart-job <id> [--json]   (orch restart restarts the daemon, not a job)');
    assert.equal(exitCode, 1);
  });

  test('an option in the place of the id is refused like a missing id', async () => {
    const { calls, err, exitCode } = await run(['restart-job', '--force']);

    assert.deepEqual(calls, []);
    assert.match(err, /^Usage: orch restart-job <id>/);
    assert.equal(exitCode, 1);
  });

  test('a reply without a reason still explains itself (an older daemon)', async () => {
    const { err, exitCode } = await run(['restart-job', 'srv'], { id: 'srv', wasRunning: false, killed: 0, started: false, pid: null });

    assert.equal(err, 'Job "srv" was not started: the daemon gave no reason');
    assert.equal(exitCode, 1);
  });

  // The real entry point builds its own daemon client: its stand-in records the options each command is sent with.
  test('main() lets restart-job take up to 30 s to answer (it waits for the old instance to end), other commands the default', async () => {
    // The exports of the kit are getters: the module record is swapped instead, and put back.
    require('@wadeck-app/singleton-daemon-kit');
    const record = require.cache[require.resolve('@wadeck-app/singleton-daemon-kit')];
    const originalExports = record.exports;
    const originalArgv = process.argv;
    const originalLog = console.log;
    const sent = [];
    record.exports = { ...originalExports, createDaemonClient: () => ({
      send: async (command, payload, options) => { sent.push({ command, options }); return command === 'list-jobs' ? [] : { id: 'srv', wasRunning: false, killed: 0, started: true, pid: 5 }; },
      version: async () => ({}),
    }) };
    console.log = () => {};
    try {
      const { main } = require('../src/cli');
      process.argv = [process.argv[0], 'orch', 'restart-job', 'srv'];
      await main();
      process.argv = [process.argv[0], 'orch', 'list'];
      await main();
    } finally {
      record.exports = originalExports;
      process.argv = originalArgv;
      console.log = originalLog;
    }

    assert.deepEqual(sent.map((s) => s.command), ['restart-job', 'list-jobs']);
    assert.deepEqual(sent[0].options, { timeoutMs: 30_000 });
    assert.equal(sent[1].options, undefined);
  });
});
