'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { DashboardManager } = require('../src/dashboard-manager');

/*
 * `<configDir>/config.dashboard` outlives the process it names.
 *
 * The dashboard is on-demand and shuts itself down when idle (P-3), so the normal end of its life
 * leaves a file naming a pid that is gone. `classifyDashboard` exists for exactly this and was wired
 * into cli.ts's `server start/stop/status` only -- never into the daemon. So a stale file self-healed
 * if you happened to run `orch server start`, and otherwise sat there: one was found naming pid 77244
 * from the previous evening, and the daemon's own fallback could only say "cannot open browser: port
 * unknown" about it.
 *
 * The daemon now sweeps it at startup. The sweep reports what it did rather than working in silence,
 * because a file disappearing is the kind of thing someone later wants explained.
 */

const dirs = [];

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dash-sweep-'));
  dirs.push(dir);
  const logs = [];
  const mgr = new DashboardManager(dir, path.join(dir, 'fake-server'), (msg) => logs.push(msg));
  return { dir, mgr, logs, file: path.join(dir, 'config.dashboard') };
}

/** A pid that is certainly not running. */
const DEAD_PID = 0x7ffffffe;

describe('the daemon sweeps a stale dashboard file at startup', () => {
  test('a file naming a dead pid is removed', () => {
    const { mgr, file } = makeEnv();
    fs.writeFileSync(file, JSON.stringify({ port: 47951, pid: DEAD_PID, startedAt: '2026-09-18T20:37:00.000Z' }));

    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), false, 'the stale file survived the sweep');
  });

  test('it says what it removed, rather than deleting a file in silence', () => {
    const { mgr, file, logs } = makeEnv();
    fs.writeFileSync(file, JSON.stringify({ port: 47951, pid: DEAD_PID }));

    mgr.sweepStaleFile();

    const said = logs.join('\n');
    assert.match(said, /stale/i, `nothing explained the removal: ${said}`);
    assert.match(said, /47951/, 'the message does not say which dashboard it was');
  });

  test('a file that is not JSON is removed too', () => {
    const { mgr, file } = makeEnv();
    fs.writeFileSync(file, 'not json at all');

    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), false, 'a corrupt file was kept');
  });

  // JSON, but missing the two fields anything can act on.
  test('a file missing port or pid is removed', () => {
    const { mgr, file } = makeEnv();
    fs.writeFileSync(file, JSON.stringify({ startedAt: '2026-09-18T20:37:00.000Z' }));

    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), false);
  });

  /*
   * The one case that must NOT be swept. A dashboard started by a previous daemon and still serving is
   * reachable, and deleting its file would orphan a live server: nothing would know its port, the tray
   * could not open it, and the next start would bind a second one.
   */
  test('a file naming a live process is left alone', () => {
    const { mgr, file } = makeEnv();
    fs.writeFileSync(file, JSON.stringify({ port: 47951, pid: process.pid }));

    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), true, 'the sweep removed the file of a live dashboard');
  });

  test('no file is not a problem and says nothing', () => {
    const { mgr, file, logs } = makeEnv();

    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(logs, [], 'the absence of a file is the normal case, not news');
  });

  test('it is safe to call twice', () => {
    const { mgr, file } = makeEnv();
    fs.writeFileSync(file, JSON.stringify({ port: 47951, pid: DEAD_PID }));

    mgr.sweepStaleFile();
    mgr.sweepStaleFile();

    assert.equal(fs.existsSync(file), false);
  });
});

describe('the daemon actually calls it', () => {
  // Asserted on the source: the call sits inside createDaemon's setup, which a unit test cannot drive
  // without starting a real daemon and its tray. Same approach as update-deferral.test.js.
  test('index.ts sweeps the dashboard file at startup', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    assert.match(src, /sweepStaleFile\(\)/,
      'nothing sweeps config.dashboard at startup; a stale file will sit there until `orch server start`');
  });
});
