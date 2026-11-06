'use strict';

// Every orch command (a person's, a cron job's, an agent's) checks that the registered start-at-login entry still resolves, and
// re-registers it when it is broken: after a node or npm prefix change the daemon would otherwise not start at the next login.
// A drift (the entry starts another install than the one running this command) is only said, and only by `orch status`: two
// callers under different nodes would rewrite it back and forth. The check runs at most once an hour, except `orch status`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { runStartupCheck, STARTUP_CHECK_STAMP } = require('../src/startup-check');

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-check-'));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });

const NOW = Date.parse('2026-11-06T10:00:00Z');
const HOUR = 3_600_000;

/** `reports` maps successive calls to what inspect/repair answers; `says` collects what was printed. */
function setup({ report = { state: 'ok', problems: [] }, repair = null, command = 'list', releaseBuild = true, now = NOW } = {}) {
  const configDir = tmp();
  const says = [];
  const calls = [];
  const deps = {
    configDir, command, releaseBuild, now,
    inspect: () => { calls.push('inspect'); return report; },
    repair: () => { calls.push('repair'); return { report, repair }; },
    say: (line) => says.push(line),
  };
  return { deps, says, calls, configDir, stamp: path.join(configDir, STARTUP_CHECK_STAMP) };
}

const BROKEN = { state: 'broken', problems: ['the daemon bundle /old/orchestrator.cjs is gone'] };
const DRIFT  = { state: 'drift', problems: ['the entry starts the daemon bundle /a, this orch runs from /b'] };

describe('runStartupCheck', () => {
  test('an entry that is fine says nothing and is not checked again for an hour', () => {
    const { deps, says, calls, stamp } = setup();
    runStartupCheck(deps);
    assert.deepEqual(says, []);
    assert.equal(fs.existsSync(stamp), true);
    runStartupCheck({ ...deps, now: NOW + HOUR - 1 });
    assert.deepEqual(calls, ['repair'], 'the second call within the hour does not look again');
    runStartupCheck({ ...deps, now: NOW + HOUR });
    assert.deepEqual(calls, ['repair', 'repair']);
  });

  test('a broken entry is re-registered, said once with what was wrong, and the check settles', () => {
    const { deps, says, stamp } = setup({ report: BROKEN, repair: { ok: true, detail: 'x' } });
    runStartupCheck(deps);
    assert.equal(says.length, 1, JSON.stringify(says));
    assert.match(says[0], /\/old\/orchestrator\.cjs is gone/);
    assert.match(says[0], /re-registered/);
    assert.equal(fs.existsSync(stamp), true);
  });

  test('a broken entry that cannot be re-registered is a warning at every call, with the way out', () => {
    const { deps, says, stamp } = setup({ report: BROKEN, repair: { ok: false, error: 'no systemd user session' } });
    runStartupCheck(deps);
    runStartupCheck({ ...deps, now: NOW + 1000 });
    assert.equal(says.length, 2, 'not throttled: it is still broken');
    assert.match(says[0], /no systemd user session/);
    assert.match(says[0], /orch install/);
    assert.equal(fs.existsSync(stamp), false);
  });

  test('a development build says the entry is broken and does not rewrite it with its own paths', () => {
    const { deps, says, calls } = setup({ report: BROKEN, releaseBuild: false });
    runStartupCheck(deps);
    assert.deepEqual(calls, ['inspect']);
    assert.equal(says.length, 1);
    assert.match(says[0], /development build/);
    assert.match(says[0], /orch install/);
  });

  test('a drift is silent for a command, said by `orch status`, and never rewritten', () => {
    const quiet = setup({ report: DRIFT });
    runStartupCheck(quiet.deps);
    assert.deepEqual(quiet.says, []);

    const status = setup({ report: DRIFT, command: 'status' });
    runStartupCheck(status.deps);
    assert.equal(status.says.length, 1);
    assert.match(status.says[0], /this orch runs from \/b/);
    assert.match(status.says[0], /orch install/);
  });

  test('`orch status` always looks, even within the hour, and says when nothing is registered', () => {
    const { deps, says, calls, configDir } = setup({ report: { state: 'absent', problems: [] }, command: 'status' });
    fs.writeFileSync(path.join(configDir, STARTUP_CHECK_STAMP), String(NOW));
    runStartupCheck(deps);
    assert.deepEqual(calls, ['repair']);
    assert.equal(says.length, 1);
    assert.match(says[0], /not registered/);
    assert.match(says[0], /orch install/);
  });

  test('install and uninstall are not checked: they are the repair', () => {
    for (const command of ['install', 'uninstall']) {
      const { deps, says, calls } = setup({ report: BROKEN, command });
      runStartupCheck(deps);
      assert.deepEqual(calls, []);
      assert.deepEqual(says, []);
    }
  });

  test('a check that throws is a warning, never a failed command', () => {
    const { deps, says } = setup();
    assert.doesNotThrow(() => runStartupCheck({ ...deps, repair: () => { throw new Error('boom'); } }));
    assert.equal(says.length, 1);
    assert.match(says[0], /check failed: boom/);
  });

  test('an unreadable stamp counts as no stamp: the check runs', () => {
    const { deps, calls, configDir } = setup();
    fs.writeFileSync(path.join(configDir, STARTUP_CHECK_STAMP), 'not a number');
    runStartupCheck(deps);
    assert.deepEqual(calls, ['repair']);
  });
});
