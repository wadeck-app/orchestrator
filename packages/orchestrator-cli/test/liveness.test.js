'use strict';

const { test, describe, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { checkLiveness, startShellCommand, LIVENESS_COMMAND_TIMEOUT_SECONDS } = require('../src/liveness');
const { FakeTime } = require('../src/time-service');

function tmpFile() {
  return path.join(os.tmpdir(), `orch-liveness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// pidFile strategy needs a configurable base dir
const ORCH_CONFIG_DIR = path.join(os.tmpdir(), `orch-liveness-config-${Date.now()}`);
process.env.ORCH_CONFIG_DIR = ORCH_CONFIG_DIR;

describe('none / null strategy', () => {
  test('null liveness returns false', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: null }), false);
  });

  test('strategy:none returns false', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'none' } }), false);
  });
});

describe('portFile strategy', () => {
  test('returns true when port file contains alive PID', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid }));
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), true);
    fs.unlinkSync(f);
  });

  test('returns false when port file contains dead PID', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ pid: 999999999 }));
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), false);
    fs.unlinkSync(f);
  });

  test('returns false when port file is absent', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: '/no/such/file.json' } }), false);
  });

  test('returns false when port file is malformed JSON', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, 'not-json');
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), false);
    fs.unlinkSync(f);
  });

  test('expands tilde in portFile path', async () => {
    // Just confirm it does not throw and returns false (no file at that path)
    const result = await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: '~/no-such-file.json' } });
    assert.equal(result, false);
  });
});

describe('pidFile strategy', () => {
  test('returns true when pid file contains alive PID', async () => {
    const pidsDir = path.join(ORCH_CONFIG_DIR, 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, 'my-job.pid'), String(process.pid));
    assert.equal(await checkLiveness({ id: 'my-job', liveness: { strategy: 'pidFile' } }), true);
  });

  test('returns false when pid file is absent', async () => {
    assert.equal(await checkLiveness({ id: 'no-such-job', liveness: { strategy: 'pidFile' } }), false);
  });

  test('returns false when pid file contains dead PID', async () => {
    const pidsDir = path.join(ORCH_CONFIG_DIR, 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, 'dead-job.pid'), '999999999');
    assert.equal(await checkLiveness({ id: 'dead-job', liveness: { strategy: 'pidFile' } }), false);
  });
});

describe('command strategy', () => {
  test('returns true when command exits 0', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'node -e "process.exit(0)"' } }), true);
  });

  test('returns false when command exits non-zero', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'node -e "process.exit(1)"' } }), false);
  });

  test('returns false when command does not exist', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'no-such-binary-xyz-12345' } }), false);
  });
});

// A liveness command that never ends used to hold the decision to start the job forever. These tests never wait: the
// clock is a FakeTime and the command is a fake whose end the test decides.
describe('command strategy timeout', () => {
  function fakeCommand() {
    const run = { killed: 0, finish: null, started: [] };
    run.start = (command) => {
      run.started.push(command);
      return {
        result: new Promise((resolve) => { run.finish = resolve; }),
        kill: () => { run.killed++; },
      };
    };
    return run;
  }
  const job = (liveness) => ({ id: 'srv', liveness: { strategy: 'command', command: 'check-it', ...liveness } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('the default is 30 seconds', () => {
    assert.equal(LIVENESS_COMMAND_TIMEOUT_SECONDS, 30);
  });

  test('a command still running after the default timeout is killed and the target counts as not alive, with a warning', async () => {
    const time = new FakeTime();
    const run = fakeCommand();
    const warnings = [];
    let answer;
    const pending = checkLiveness(job({}), { time, start: run.start, warn: (m) => warnings.push(m) }).then((v) => { answer = v; });
    time.advance(29_999);
    await flush();
    assert.equal(answer, undefined, 'still waiting one millisecond before the timeout');
    assert.equal(run.killed, 0);
    time.advance(1);
    await pending;
    assert.equal(answer, false);
    assert.equal(run.killed, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"srv"/);
    assert.match(warnings[0], /30 s/);
    assert.match(warnings[0], /--liveness-timeout/);
  });

  test('liveness.timeoutSeconds replaces the default', async () => {
    const time = new FakeTime();
    const run = fakeCommand();
    let answer;
    const pending = checkLiveness(job({ timeoutSeconds: 5 }), { time, start: run.start, warn: () => {} }).then((v) => { answer = v; });
    time.advance(4_999);
    await flush();
    assert.equal(answer, undefined);
    time.advance(1);
    await pending;
    assert.equal(answer, false);
    assert.equal(run.killed, 1);
  });

  test('a command that exits 0 in time is alive: no kill, no warning, no timer left armed', async () => {
    const time = new FakeTime();
    const run = fakeCommand();
    const warnings = [];
    const pending = checkLiveness(job({}), { time, start: run.start, warn: (m) => warnings.push(m) });
    run.finish(true);
    assert.equal(await pending, true);
    assert.equal(run.killed, 0);
    assert.deepEqual(warnings, []);
    assert.equal(time.pending, 0);
  });

  test('a command that fails in time is not alive, without a warning', async () => {
    const time = new FakeTime();
    const run = fakeCommand();
    const warnings = [];
    const pending = checkLiveness(job({}), { time, start: run.start, warn: (m) => warnings.push(m) });
    run.finish(false);
    assert.equal(await pending, false);
    assert.deepEqual(warnings, []);
    assert.equal(time.pending, 0);
  });

  test('an answer that arrives after the timeout does not change it', async () => {
    const time = new FakeTime();
    const run = fakeCommand();
    const pending = checkLiveness(job({}), { time, start: run.start, warn: () => {} });
    time.advance(30_000);
    assert.equal(await pending, false);
    run.finish(true);
    await flush();
    assert.equal(run.killed, 1);
  });

  test('a command that cannot be started is not alive', async () => {
    const pending = checkLiveness(job({}), {
      time: new FakeTime(), warn: () => {}, start: () => { throw new Error('spawn failed'); },
    });
    assert.equal(await pending, false);
  });
});

// The scheduler says the timeout on stderr. It reaches the daemon log because the daemon copies its stderr into it
// (stdio-bridge.ts, tested in stdio-bridge.test.js); under the launcher stderr is the NUL device and would lose it otherwise.
describe('the scheduler default liveness check says its timeout on stderr', () => {
  const fs   = require('node:fs');
  const { Registry }  = require('../src/registry');
  const { State }     = require('../src/state');
  const { Scheduler } = require('../src/scheduler');

  test('a hung command is killed after the configured seconds and the sink gets the line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-livewarn-'));
    try {
      const time = new FakeTime();
      const warnings = [];
      const spy = mock.method(console, 'error', (m) => { warnings.push(String(m)); });
      const sched = new Scheduler(new Registry(path.join(dir, 'registry.json')), new State(path.join(dir, 'state.json')), {
        time, eventPublisher: { publish: () => {} }, configDir: dir,
      });
      const job = { id: 'hung', liveness: { strategy: 'command', command: 'node -e "setInterval(() => {}, 1000)"', timeoutSeconds: 2 } };
      const pending = sched._liveness(job);
      time.advance(2_000);
      assert.equal(await pending, false);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /^\[scheduler\] .*"hung".*2 s.*--liveness-timeout/);
    } finally {
      mock.restoreAll();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('startShellCommand', () => {
  test('its result is true for exit 0 and false for another exit', async () => {
    assert.equal(await startShellCommand('node -e "process.exit(0)"').result, true);
    assert.equal(await startShellCommand('node -e "process.exit(3)"').result, false);
  });

  // The end of the process is awaited as an event, not slept for: kill() has to end a command that never would.
  test('kill ends a command that would never end', async () => {
    const run = startShellCommand('node -e "setInterval(() => {}, 1000)"');
    run.kill();
    assert.equal(await run.result, false);
  });
});

describe('unknown strategy', () => {
  test('returns false without throwing', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'magic' } }), false);
  });
});
