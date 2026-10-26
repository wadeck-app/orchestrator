'use strict';

// What the tray binary prints on stderr goes to the tray log (logs/app/tray-<date>.log). It used to go to console.error too, which
// was lost under the launcher; now that the daemon copies its stderr into the daemon log (stdio-bridge.ts) that second copy
// would put every SetIcon / set-menu line of the tray there as well (413 lines in one day, each with a doubled prefix).
const { test, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

const dirs = [];
const ORIGINAL = process.env.ORCH_NO_TRAY;
afterEach(() => {
  mock.restoreAll();
  if (ORIGINAL === undefined) { delete process.env.ORCH_NO_TRAY; } else { process.env.ORCH_NO_TRAY = ORIGINAL; }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a line the tray prints on stderr is logged once, in the tray log, and not copied to console.error', async () => {
  // The suite's preload sets ORCH_NO_TRAY for the whole run; this test needs the tray path to run, with a fake binary.
  delete process.env.ORCH_NO_TRAY;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-tray-stderr-'));
  dirs.push(dir);
  const scheduler = Object.assign(new EventEmitter(), { runningCount: () => 0 });
  const mgr = new TrayManager(dir, scheduler, { getAll: () => ({}) }, { list: () => [] }, '0.0.0-test', undefined, null);
  const logs = [];
  mgr.on('log', (line) => logs.push(line));

  let stderrLine = null;
  mgr._findBinary = () => path.join(dir, 'fake-tray');
  mgr._createTray = () => ({
    killed: false,
    kill: async () => {},
    onStderrLine: (cb) => { stderrLine = cb; },
    onExit: () => {},
    onError: () => {},
    onClicked: () => {},
    onStreamError: () => {},
    onSendFailed: () => {},
    writeNow: async () => true,
    process: { pid: 0 },
    ready: async () => {},
    send: async () => true,
    capturedStderr: () => '',
  });

  const printed = [];
  mock.method(console, 'error', (...args) => { printed.push(args.join(' ')); });

  await mgr._spawnTray();
  assert.equal(typeof stderrLine, 'function', 'the manager did not listen to the tray stderr');
  stderrLine('SetIcon called: 700 bytes');

  assert.ok(logs.some((l) => l.includes('[tray-go] SetIcon called: 700 bytes')), `not in the tray log: ${JSON.stringify(logs)}`);
  assert.deepEqual(printed.filter((l) => l.includes('SetIcon')), [], 'also printed on console.error');
  await mgr.stop?.();
});
