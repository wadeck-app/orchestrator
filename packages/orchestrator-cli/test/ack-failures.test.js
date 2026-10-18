'use strict';

// The failure notifications have one "Acknowledge" button per job and an "Acknowledge all". The daemon
// only knew how to acknowledge everything: pressing the button on one job acknowledged every failure on
// the server while the screen hid just that card, so the others vanished at the next refresh without
// anyone having looked at them. Acknowledging a job has to acknowledge that job.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

function failed(state, id, minute) {
  state.record(id, {
    startedAt: `2026-10-18T09:${minute}:00Z`, finishedAt: `2026-10-18T09:${minute}:30Z`, exitCode: 1, pid: 1,
  });
}

function env() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ack-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  failed(state, 'a', '10');
  failed(state, 'b', '20');
  failed(state, 'c', '30');
  let trayCleared = 0;
  const tray = { clearFailures: () => { trayCleared++; } };
  const scheduler = { killJob: async () => ({ killed: false }), skipNextFiring: () => {}, scheduleJob: () => {}, unscheduleJob: () => {} };
  const commands = makeCommands(registry, state, scheduler, dir, tray);
  return { state, commands, trayCleared: () => trayCleared };
}

const ids = (state) => state.getUnacknowledgedFailures().map(f => f.jobId).sort();

describe('State.acknowledge', () => {
  test('acknowledges the failure of that job and no other', () => {
    const { state } = env();
    assert.equal(state.acknowledge('b'), true);
    assert.deepEqual(ids(state), ['a', 'c']);
  });

  test('says when there was nothing to acknowledge, instead of pretending', () => {
    const { state } = env();
    assert.equal(state.acknowledge('does-not-exist'), false);
    state.acknowledge('a');
    assert.equal(state.acknowledge('a'), false, 'a failure already acknowledged');
    assert.deepEqual(ids(state), ['b', 'c']);
  });
});

describe('ack-failures', () => {
  test('with a job id acknowledges that job only', () => {
    const { state, commands } = env();
    commands['ack-failures']({ jobId: 'a' });
    assert.deepEqual(ids(state), ['b', 'c']);
  });

  test('without one acknowledges everything, as before', () => {
    const { state, commands, trayCleared } = env();
    commands['ack-failures']();
    assert.deepEqual(ids(state), []);
    assert.equal(trayCleared(), 1);
    commands['ack-failures']({});
    assert.deepEqual(ids(state), []);
  });

  test('clears the tray only when no failure is left to show there', () => {
    const { commands, trayCleared } = env();
    commands['ack-failures']({ jobId: 'a' });
    commands['ack-failures']({ jobId: 'b' });
    assert.equal(trayCleared(), 0, 'one failure is still waiting');
    commands['ack-failures']({ jobId: 'c' });
    assert.equal(trayCleared(), 1);
  });

  test('refuses a job id that is not a string, by name, rather than acknowledging everything', () => {
    const { state, commands } = env();
    assert.throws(() => commands['ack-failures']({ jobId: 42 }), /jobId must be a string/);
    assert.deepEqual(ids(state), ['a', 'b', 'c']);
  });
});
