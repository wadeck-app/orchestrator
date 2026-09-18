'use strict';

// Editing a job from the web UI did nothing: no change, no error shown. The daemon was throwing
// "Cannot convert undefined or null to object" from Object.keys(updates), because orch-server sent
// the fields flattened while edit-job reads payload.updates.
//
// The server is fixed, but the daemon should say what is wrong with a malformed payload rather than
// leaking a TypeError from deep inside the handler: the message is what a caller debugs against, and
// that one names nothing.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];

const JOB = { id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v', label: 'Original' };

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-edit-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.add(JOB);
  // scheduleJob/unscheduleJob are part of the interface now: every job mutation hands the change to
  // the running scheduler, or nothing a caller does takes effect until the next daemon restart.
  const scheduler = {
    killJob: async () => ({ killed: false }), skipNextFiring: () => {},
    scheduleJob: () => {}, unscheduleJob: () => {},
  };
  const commands = makeCommands(registry, state, scheduler, dir);
  return { commands, registry };
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('edit-job applies the update', () => {
  test('the documented shape works', () => {
    const { commands, registry } = makeEnv();

    const result = commands['edit-job']({ id: 'j1', updates: { label: 'Renamed' } });

    assert.equal(result.label, 'Renamed');
    assert.equal(registry.get('j1').label, 'Renamed', 'the change never reached the registry');
    assert.equal(registry.get('j1').command, 'node -v', 'unrelated fields were dropped');
  });
});

describe('edit-job rejects a malformed payload by name', () => {
  // What the web UI actually sent: the fields flattened, so `updates` was absent.
  test('a missing updates says so, instead of leaking a TypeError', () => {
    const { commands } = makeEnv();

    assert.throws(
      () => commands['edit-job']({ id: 'j1', label: 'Renamed' }),
      (err) => {
        assert.ok(!/Cannot convert undefined or null to object/.test(err.message),
          `leaked an internal TypeError instead of naming the problem: ${err.message}`);
        assert.match(err.message, /updates/,
          `the message does not name the missing field: ${err.message}`);
        return true;
      },
    );
  });

  test('a null updates is rejected the same way', () => {
    const { commands } = makeEnv();
    assert.throws(() => commands['edit-job']({ id: 'j1', updates: null }), /updates/);
  });

  test('a non-object updates is rejected', () => {
    const { commands } = makeEnv();
    assert.throws(() => commands['edit-job']({ id: 'j1', updates: 'Renamed' }), /updates/);
  });

  test('a rejected payload leaves the job untouched', () => {
    const { commands, registry } = makeEnv();

    assert.throws(() => commands['edit-job']({ id: 'j1', label: 'Renamed' }));

    const job = registry.get('j1');
    assert.equal(job.label, 'Original', 'a rejected edit still wrote to the registry');
    assert.equal(job.command, 'node -v');
  });

  test('a missing id is named too', () => {
    const { commands } = makeEnv();
    assert.throws(() => commands['edit-job']({ updates: { label: 'x' } }), /id/);
  });
});
