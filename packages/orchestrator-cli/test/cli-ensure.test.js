'use strict';

// `orch ensure` makes a job exist with the flags given (added / updated / unchanged), so a CLI can register its own
// startup job from its install command and run it as often as it likes. `orch remove --if-exists` is its uninstall.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

const STARTUP = { id: 'machine', type: 'startup', command: 'machine daemon', enabled: true, timeoutSeconds: 0, restartOnExit: true };

async function run(argv, jobs = {}, restartReply = { started: true, pid: 5, wasRunning: true, killed: 1 }) {
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
      send: async (command, payload) => {
        calls.push({ command, payload });
        if (command === 'get-job') { return jobs[payload.id] ?? null; }
        if (command === 'restart-job') { return restartReply; }
        return {};
      },
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    });
  } catch (e) {
    if (e.message !== 'exit') { throw e; }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { calls, out: out.join('\n'), err: err.join('\n'), exitCode };
}

const sent = (calls) => calls.map(c => c.command).filter(c => c !== 'get-job');

describe('orch ensure', () => {
  test('a missing job is added with the flags given', async () => {
    const { calls, out, exitCode } = await run(['ensure', 'startup', 'machine', '--command', 'machine daemon', '--timeout', '0']);

    assert.equal(exitCode, 0);
    assert.equal(out, 'added machine');
    assert.deepEqual(sent(calls), ['add-job']);
    assert.deepEqual(calls.find(c => c.command === 'add-job').payload, {
      id: 'machine', type: 'startup', command: 'machine daemon', enabled: true, timeoutSeconds: 0,
    });
  });

  test('the same flags on an existing job change nothing: no edit is sent', async () => {
    const { calls, out, exitCode } = await run(
      ['ensure', 'startup', 'machine', '--command', 'machine daemon', '--timeout', '0', '--restart-on-exit'], { machine: STARTUP });

    assert.equal(exitCode, 0);
    assert.equal(out, 'unchanged machine');
    assert.deepEqual(sent(calls), []);
  });

  test('a moved executable path is an update, and only that field is sent', async () => {
    const cmd = '"C:\\Users\\me\\.config\\bin\\2\\machine.exe" daemon';
    const { calls, out } = await run(['ensure', 'startup', 'machine', '--command', cmd, '--timeout', '0'], { machine: STARTUP });

    assert.equal(out, 'updated machine (command)');
    assert.deepEqual(sent(calls), ['edit-job']);
    assert.deepEqual(calls.find(c => c.command === 'edit-job').payload, { id: 'machine', updates: { command: cmd } });
  });

  test('a field edited by hand and not given is left alone', async () => {
    const job = { ...STARTUP, description: 'edited by the user', maxConcurrency: 3 };
    const { out, calls } = await run(['ensure', 'startup', 'machine', '--command', 'machine daemon'], { machine: job });

    assert.equal(out, 'unchanged machine');
    assert.deepEqual(sent(calls), []);
  });

  test('--restart-if-changed restarts the job when its command changed', async () => {
    const { calls, out } = await run(['ensure', 'startup', 'machine', '--command', 'machine2 daemon', '--restart-if-changed'], { machine: STARTUP });

    assert.deepEqual(sent(calls), ['edit-job', 'restart-job']);
    assert.equal(out, 'updated machine (command), restarted');
  });

  test('--restart-if-changed does not restart when nothing changed', async () => {
    const { calls } = await run(['ensure', 'startup', 'machine', '--command', 'machine daemon', '--restart-if-changed'], { machine: STARTUP });

    assert.deepEqual(sent(calls), []);
  });

  test('--json says the result in one object', async () => {
    const { out } = await run(['ensure', 'startup', 'machine', '--command', 'machine2 daemon', '--json'], { machine: STARTUP });

    assert.deepEqual(JSON.parse(out), { id: 'machine', result: 'updated', changed: ['command'] });
  });

  test('an existing job of another type is refused with the way out', async () => {
    const { err, exitCode, calls } = await run(['ensure', 'cron', 'machine', '--command', 'x', '--schedule', '* * * * *'], { machine: STARTUP });

    assert.equal(exitCode, 4);
    assert.match(err, /exists as a "startup" job.*orch remove machine/s);
    assert.deepEqual(sent(calls), []);
  });

  test('a restart that did not start is an error naming the fix', async () => {
    const { err, exitCode } = await run(
      ['ensure', 'startup', 'machine', '--command', 'm2', '--restart-if-changed'], { machine: STARTUP },
      { started: false, reason: 'the liveness check says it is alive' });

    assert.equal(exitCode, 1);
    assert.match(err, /updated but not restarted: the liveness check says it is alive.*orch restart-job machine/s);
  });

  test('missing id or type, and once, are usage errors', async () => {
    for (const argv of [['ensure'], ['ensure', 'startup'], ['ensure', 'once', 'x']]) {
      const { exitCode, err } = await run(argv);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, /Usage: orch ensure/);
    }
  });

  test('an unknown flag is refused like in add and edit', async () => {
    const { exitCode, err } = await run(['ensure', 'startup', 'machine', '--command', 'x', '--bogus', '1']);

    assert.equal(exitCode, 4);
    assert.match(err, /unknown flag "--bogus"/);
  });
});

describe('orch remove --if-exists', () => {
  test('a missing job is absent, exit 0, and nothing is removed', async () => {
    const { out, exitCode, calls } = await run(['remove', 'machine', '--if-exists']);

    assert.equal(exitCode, 0);
    assert.equal(out, 'absent machine');
    assert.deepEqual(sent(calls), []);
  });

  test('an existing job is removed', async () => {
    const { out, calls } = await run(['remove', 'machine', '--if-exists'], { machine: STARTUP });

    assert.equal(out, 'removed machine');
    assert.deepEqual(sent(calls), ['remove-job']);
  });

  test('without the flag remove keeps its sentence', async () => {
    const { out } = await run(['remove', 'machine'], { machine: STARTUP });

    assert.equal(out, 'Job "machine" removed.');
  });
});
