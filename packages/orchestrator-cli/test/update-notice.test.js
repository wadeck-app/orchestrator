'use strict';

// update-state.json can now hold status 'applying' (shared-updater journals the install BEFORE running
// npm). Read by `orch` and by the daemon, it used to be dropped in silence: an interrupted install, which
// leaves the CLI removed, said nothing at all.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { updateNotice, APPLYING_STALE_MS } = require('../src/update-notice');

const NOW = 1_800_000_000_000;
const alive = () => true;
const dead = () => false;

describe('terminal states keep their wording', () => {
  test('success', () => {
    assert.equal(updateNotice({ status: 'success', targetVersion: '2026.1.1-001-aaaaaaaa', timestamp: NOW }, { now: NOW, isAlive: alive }).text, 'Updated to v2026.1.1-001-aaaaaaaa');
  });
  test('rolled-back', () => {
    assert.equal(updateNotice({ status: 'rolled-back', previousVersion: '1.0.0', timestamp: NOW }, { now: NOW, isAlive: alive }).text, 'Rollback to v1.0.0');
  });
  test('failed carries the reason, which can be a manual fix command', () => {
    const n = updateNotice({ status: 'failed', error: 'Fix manually: npm install -g x@1', timestamp: NOW }, { now: NOW, isAlive: alive });
    assert.equal(n.text, 'Update failed (Fix manually: npm install -g x@1)');
    assert.equal(n.level, 'warn');
  });
  test('states that are not news are silent', () => {
    assert.equal(updateNotice({ status: 'update-available', timestamp: NOW }, { now: NOW, isAlive: alive }), null);
    assert.equal(updateNotice(null, { now: NOW, isAlive: alive }), null);
  });
});

describe("'applying'", () => {
  const applying = { status: 'applying', pid: 4242, previousVersion: '2026.1.1-001-aaaaaaaa', targetVersion: '2026.2.2-002-bbbbbbbb', timestamp: NOW - 5_000 };

  test('with a live updater it is in progress, not a failure', () => {
    const n = updateNotice(applying, { now: NOW, isAlive: alive });
    assert.equal(n.level, 'info');
    assert.match(n.text, /update to v2026\.2\.2-002-bbbbbbbb is in progress \(pid 4242\)/);
    assert.doesNotMatch(n.text, /interrupted/);
  });

  test('with a dead updater it is an interrupted install and says how it gets repaired', () => {
    const n = updateNotice(applying, { now: NOW, isAlive: dead });
    assert.equal(n.level, 'warn');
    assert.match(n.text, /interrupted/);
    assert.match(n.text, /v2026\.2\.2-002-bbbbbbbb/);
    assert.match(n.text, /orch cli update/);
    assert.match(n.text, /npm install -g @wadeck-app\/orchestrator-cli@latest/);
  });

  test('a live pid on a record older than the staleness window is a recycled pid: interrupted', () => {
    const old = { ...applying, timestamp: NOW - APPLYING_STALE_MS - 1 };
    assert.match(updateNotice(old, { now: NOW, isAlive: alive }).text, /interrupted/);
  });

  // shared-updater 2026.10.25-020 journals the npm child's pid. A hard-killed updater can leave npm running: it is
  // still writing the global directory, and the next update run waits for it (then stops it) before it repairs.
  test('a dead updater whose npm is still running says the repair will wait for it', () => {
    const n = updateNotice({ ...applying, npmPid: 777, npmStartedAt: NOW - 3_000 }, { now: NOW, isAlive: (pid) => pid === 777 });
    assert.equal(n.level, 'warn');
    assert.match(n.text, /interrupted/);
    assert.match(n.text, /npm \(pid 777\) is still running/);
    assert.match(n.text, /waits for it/);
  });

  test('a dead updater whose npm is gone does not mention npm', () => {
    const n = updateNotice({ ...applying, npmPid: 777 }, { now: NOW, isAlive: dead });
    assert.doesNotMatch(n.text, /pid 777/);
  });

  test('a record without a pid cannot be called in progress', () => {
    const { pid, ...noPid } = applying;
    assert.match(updateNotice(noPid, { now: NOW, isAlive: alive }).text, /interrupted/);
  });

  test('missing versions are shown as unknown rather than as "undefined"', () => {
    const n = updateNotice({ status: 'applying', pid: 1, timestamp: NOW }, { now: NOW, isAlive: alive });
    assert.doesNotMatch(n.text, /undefined/);
  });
});

describe('isPidAlive default', () => {
  test('the current process is alive, a huge pid is not', () => {
    const { isPidAlive } = require('../src/update-notice');
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(2 ** 31 - 2), false);
  });
});
