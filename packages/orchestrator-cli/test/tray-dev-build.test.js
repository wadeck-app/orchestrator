'use strict';

// The tray's version row runs `npm view` and compares with the running version. A development build (0.2.0,
// or <release>-local-dev) can never equal what npm publishes, so it claimed "update available" for ever and its
// "Update to ... and restart" row led to the updater. A dev build checks nothing and offers nothing.
const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

function makeTray(version) {
  const scheduler = Object.assign(new EventEmitter(), { stop: () => {} });
  const mgr = new TrayManager(require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'orch-tray-dev-')), scheduler, { getAll: () => ({}) }, { list: () => [] }, version);
  mgr._refresh = () => {};
  const logs = [];
  mgr.on('log', (m) => logs.push(m));
  return { mgr, logs };
}

afterEach(() => mock.restoreAll());

describe('a development build', () => {
  for (const version of ['0.2.0', '2026.10.24-514-aac78c7a-local-dev']) {
    test(`${version}: the version row checks nothing, says why, and never offers an install`, async () => {
      const calls = [];
      mock.method(childProcess, 'execFile', (...args) => { calls.push(args); });
      mock.method(childProcess, 'exec', (...args) => { calls.push(args); });
      const { mgr, logs } = makeTray(version);
      await mgr._checkForUpdate();
      assert.deepEqual(calls, [], 'npm view was run for a development build');
      assert.notEqual(mgr._updateStatus, 'available');
      assert.notEqual(mgr._updateStatus, 'checking');
      assert.match(mgr._versionLabel ?? '', /development build/i);
      assert.equal(mgr._buildMenu().items.some((i) => i.id === 'update-install'), false);
      assert.match(logs.join('\n'), /dev build/);
    });
  }
});

describe('a release build', () => {
  test('still asks npm, with one command string: an args array with shell:true is Node DEP0190, printed at every daemon start', { timeout: 10_000 }, async () => {
    const calls = [];
    const execFileCalls = [];
    mock.method(childProcess, 'exec', (...args) => { calls.push(args); const cb = args[args.length - 1]; cb(new Error('mocked: no network')); });
    mock.method(childProcess, 'execFile', (...args) => { execFileCalls.push(args); });
    const { mgr } = makeTray('2026.10.24-514-aac78c7a');
    await mgr._checkForUpdate();
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'npm view @wadeck-app/orchestrator-cli version --json');
    assert.deepEqual(execFileCalls, [], 'execFile with an args array and a shell');
  });
});
