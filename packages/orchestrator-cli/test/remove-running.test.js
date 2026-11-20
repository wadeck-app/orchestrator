'use strict';

// Removing a job does not stop a run that is going (it keeps writing its telemetry and logs): that was said nowhere, and the
// run could then not be found by anyone (found with a probe job: `startup disable` of a CLI removed the job and left its
// whole process tree running). The removal now says so, with the command that ends it.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { runCli } = require('../src/cli');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function env(running) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rm-running-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const scheduler = {
    killJob: async () => ({ killed: false }), runningCount: () => running, skipNextFiring: () => {},
    scheduleJob: () => {}, unscheduleJob: () => {},
  };
  const commands = makeCommands(registry, new State(path.join(dir, 'state.json')), scheduler, dir);
  commands['add-job']({ id: 'svc', type: 'startup', command: 'node -v', label: 'S' });
  return commands;
}

describe('remove-job reply', () => {
  test('says how many runs are still going', () => {
    const reply = env(2)['remove-job']({ id: 'svc' });

    assert.equal(reply.stillRunning, 2);
  });

  test('a job with no run going gets no extra field', () => {
    assert.equal(env(0)['remove-job']({ id: 'svc' }), undefined);
  });
});

async function removeWith(sendResult) {
  const errs = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (m) => { errs.push(String(m)); };
  console.log = () => {};
  try {
    await runCli(['remove', 'svc'], { send: async () => sendResult, startDaemon: () => {}, configDir: os.tmpdir() });
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  return errs.join('\n');
}

describe('orch remove', () => {
  test('a run still going is said, with the command that ends it', async () => {
    const err = await removeWith({ stillRunning: 1 });

    assert.match(err, /1 run of "svc" is still going/);
    assert.match(err, /orch kill svc/);
  });

  test('several runs are counted', async () => {
    assert.match(await removeWith({ stillRunning: 3 }), /3 runs of "svc" are still going/);
  });

  test('nothing to say when no run is going', async () => {
    assert.equal(await removeWith(undefined), '');
  });
});

// The removal's own advice is `orch kill <id>`: it has to work on an id that is no longer a job, or the run stays unreachable.
describe('orch kill of an id that is no longer a job', () => {
  async function killWith(handlers) {
    const out = [];
    const errs = [];
    const origErr = console.error;
    const origLog = console.log;
    const origExit = process.exit;
    console.error = (m) => { errs.push(String(m)); };
    console.log = (m) => { out.push(String(m)); };
    process.exit = (code) => { throw new Error(`exit ${code}`); };
    let exit = null;
    try {
      await runCli(['kill', 'gone'], {
        send: async (cmd) => handlers[cmd]?.(), startDaemon: () => {}, configDir: os.tmpdir(),
      });
    } catch (err) {
      exit = err.message;
    } finally {
      console.error = origErr;
      console.log = origLog;
      process.exit = origExit;
    }
    return { out: out.join('\n'), err: errs.join('\n'), exit };
  }

  test('ends the run that is still going', async () => {
    const r = await killWith({ 'get-job': () => null, 'kill-job': () => ({ killed: true, count: 1 }) });

    assert.equal(r.exit, null);
    assert.match(r.out, /Job "gone" killed/);
  });

  test('still says unknown when nothing was running under that id', async () => {
    const r = await killWith({ 'get-job': () => null, 'kill-job': () => ({ killed: false }) });

    assert.match(r.err, /Unknown job "gone"/);
    assert.equal(r.exit, 'exit 1');
  });
});
