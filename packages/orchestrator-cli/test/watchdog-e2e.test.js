'use strict';

// The REAL watchdog bundle (esbuild, same options as scripts/bundle.ts) started with plain `node`, supervising a FAKE daemon
// bundle (test/helpers/fake-watchdog-daemon.js) that exits with a scripted sequence. Counterpart of launcher-e2e.test.js, which
// drives the Go launcher and the real daemon: here the real daemon is not needed, the watchdog's contract is.
//
// The watchdog is started the way `orch start --watchdog` starts it (stdio ignored, windowsHide), in a throwaway config dir.
// ORCH_WATCHDOG_DELAYS_MS and ORCH_WATCHDOG_WINDOW_MS are the test-only variables that shorten the 2s/10s/30s back-off.
// Nothing here touches the real config dir, the registry or a real daemon.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const esbuild = require('esbuild');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wd-e2e-'));
const distDir = path.join(root, 'dist');
const watchdogBundle = path.join(distDir, 'orchestrator-watchdog.cjs');
const sourceRoot = path.join(__dirname, '..');

before(() => {
  fs.mkdirSync(distDir, { recursive: true });
  const common = { bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: [], logLevel: 'warning' };
  esbuild.buildSync({ ...common, entryPoints: [path.join(sourceRoot, 'src', 'watchdog', 'main.ts')], outfile: watchdogBundle });
  esbuild.buildSync({ ...common, entryPoints: [path.join(__dirname, 'helpers', 'fake-watchdog-daemon.js')], outfile: path.join(distDir, 'orchestrator.cjs') });
  for (const file of [watchdogBundle, path.join(distDir, 'orchestrator.cjs')]) {
    if (!fs.existsSync(file)) {
      throw new Error(`the bundle ${file} was not built: this test does not skip, fix the build`);
    }
  }
});

const cleanups = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()();
  }
});
after(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

async function until(what, predicate, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

const readIf = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/** A throwaway config dir plus the views a test asserts on. */
function scenario() {
  const configDir = fs.mkdtempSync(path.join(root, 'cfg-'));
  const s = {
    configDir,
    starts: () => readIf(path.join(configDir, 'starts.log')).split('\n').filter((l) => l !== '').map((l) => JSON.parse(l)),
    log: () => {
      const logs = path.join(configDir, 'logs');
      return fs.existsSync(logs) ? fs.readdirSync(logs).filter((f) => f.endsWith('-launcher.log')).map((f) => fs.readFileSync(path.join(logs, f), 'utf8')).join('') : '';
    },
    file: (name) => path.join(configDir, name),
  };
  return s;
}

/**
 * Starts the real watchdog bundle. `dist` lets a test run a copy that has no daemon bundle next to it.
 * Resolves `exited` with the exit code; a test that fails reports the watchdog log.
 */
function startWatchdog(s, { plan = '', delays, window, dist = watchdogBundle, extraEnv = {} } = {}) {
  const { LAUNCHER_BUNDLE_OVERRIDE: _ignored, ...inherited } = process.env;
  const env = { ...inherited, ORCH_CONFIG_DIR: s.configDir, FAKE_DAEMON_PLAN: plan, HOME: root, USERPROFILE: root, ...extraEnv };
  if (delays !== undefined) {
    env.ORCH_WATCHDOG_DELAYS_MS = delays;
  }
  if (window !== undefined) {
    env.ORCH_WATCHDOG_WINDOW_MS = window;
  }
  const child = spawn(process.execPath, [dist, s.configDir], { stdio: 'ignore', windowsHide: true, env });
  const watchdog = { child, gone: false };
  watchdog.exited = new Promise((resolve) => child.once('exit', (code, signal) => { watchdog.gone = true; resolve({ code, signal }); }));
  cleanups.push(async () => {
    for (const { pid } of s.starts()) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    if (!watchdog.gone) {
      child.kill('SIGKILL');
    }
  });
  watchdog.finish = async (what = 'the watchdog to exit') => {
    const result = await Promise.race([
      watchdog.exited,
      new Promise((_, reject) => { setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 30_000).unref(); }),
    ]).catch((e) => {
      throw new Error(`${e.message}\n--- watchdog log ---\n${s.log()}`);
    });
    return result;
  };
  return watchdog;
}

/** No node process of the scenario is left: the watchdog and every daemon it started are gone. */
async function assertNothingLeft(s, watchdog) {
  const pids = [watchdog.child.pid, ...s.starts().map((st) => st.pid)];
  for (const pid of pids) {
    await until(`pid ${pid} to be gone`, () => !alive(pid), 10_000).catch(() => {
      throw new Error(`a node process is left: pid ${pid} (the watchdog is ${watchdog.child.pid}); starts: ${JSON.stringify(s.starts())}\n${s.log()}`);
    });
  }
}

describe('the real watchdog bundle with a fake daemon', () => {
  test('a restart sentinel starts the daemon again on the same arguments; the clean exit after it ends the watchdog with 0', async () => {
    const s = scenario();
    const w = startWatchdog(s, { plan: 'restart,exit:0' });
    const { code } = await w.finish();
    const log = s.log();
    assert.equal(code, 0, log);
    const starts = s.starts();
    assert.equal(starts.length, 2, log);
    assert.deepEqual(starts[0].argv, [s.configDir]);
    assert.equal(starts[0].configDirEnv, s.configDir);
    assert.equal(fs.existsSync(s.file('config.restart')), false, 'the sentinel must be consumed');
    assert.equal(fs.existsSync(s.file('crashed.json')), false, 'a restart is not a crash');
    assert.equal(fs.existsSync(s.file('config.launcher-pid')), false, 'the pid file is removed at exit');
    assert.match(log, /\[ INFO\] \[launcher\] restart sentinel detected/);
    assert.match(log, /\[ INFO\] \[launcher\] Exiting cleanly/);
    assert.match(log, new RegExp(`PIDs: launcher=${w.child.pid} node=${starts[1].pid}`));
    assert.ok(fs.readdirSync(path.join(s.configDir, 'logs')).some((f) => /^\d{4}-\d{2}-\d{2}-launcher\.log$/.test(f)));
    await assertNothingLeft(s, w);
  });

  test('crashes are restarted after the back-off, leave a crashed.json that says who wrote it, and a clean exit ends it with 0', async () => {
    const s = scenario();
    const w = startWatchdog(s, { plan: 'exit:1,exit:2,exit:0', delays: '30,40' });
    const { code } = await w.finish();
    const log = s.log();
    assert.equal(code, 0, log);
    assert.equal(s.starts().length, 3, log);
    assert.match(log, /\[ERROR\] \[launcher\] daemon crashed: node exited with code 1 \(crash 1 in the last 10 minutes\)/);
    assert.match(log, /restarting in 30ms \(crash 1 of 3 allowed in 10 minutes\)/);
    assert.match(log, /restarting in 40ms \(crash 2 of 3 allowed in 10 minutes\)/);
    const marker = JSON.parse(fs.readFileSync(s.file('crashed.json'), 'utf8'));
    assert.equal(marker.source, 'launcher');
    assert.match(marker.error, /code 2/, 'the later crash replaced the stale marker of the first');
    await assertNothingLeft(s, w);
  });

  test('the fourth crash inside the window is not restarted: the watchdog exits with the last code and an ERROR that says what to do', async () => {
    const s = scenario();
    const w = startWatchdog(s, { plan: 'exit:3,exit:3,exit:3,exit:7,exit:0', delays: '20' });
    const { code } = await w.finish();
    const log = s.log();
    assert.equal(code, 7, log);
    assert.equal(s.starts().length, 4, `a fifth start means the watchdog restarts without bound\n${log}`);
    assert.match(log, /\[ERROR\] \[launcher\] daemon crashed 4 times in 10 minutes, not restarting: see .*logs, then run orch start/);
    await assertNothingLeft(s, w);
  });

  test('crashes more than a window apart never accumulate (ORCH_WATCHDOG_WINDOW_MS)', async () => {
    const s = scenario();
    // A 1 ms window: no crash ever has another inside it, so five crashes in a row are all restarted.
    const w = startWatchdog(s, { plan: 'exit:1,exit:1,exit:1,exit:1,exit:1,exit:0', delays: '20', window: '1' });
    const { code } = await w.finish();
    assert.equal(code, 0, s.log());
    assert.equal(s.starts().length, 6, s.log());
    assert.match(s.log(), /\(crash 1 in the last 1ms\)/);
    await assertNothingLeft(s, w);
  });

  test('a crashed.json the daemon wrote is not overwritten by the watchdog', async () => {
    const s = scenario();
    const w = startWatchdog(s, { plan: 'crash-marker:1,exit:0', delays: '20' });
    const { code } = await w.finish();
    assert.equal(code, 0, s.log());
    const marker = JSON.parse(fs.readFileSync(s.file('crashed.json'), 'utf8'));
    assert.equal(marker.error, 'the real cause');
    assert.equal(marker.source, undefined);
    await assertNothingLeft(s, w);
  });

  test('config.launcher-pid holds the watchdog pid while the daemon runs, and the daemon is told who its watchdog is (Windows only)', async () => {
    const s = scenario();
    const w = startWatchdog(s, { plan: 'wait' });
    await until('the daemon to start', () => s.starts().length === 1);
    assert.equal(fs.readFileSync(s.file('config.launcher-pid'), 'utf8'), String(w.child.pid));
    const [start] = s.starts();
    assert.equal(start.watchdogPid, process.platform === 'win32' ? String(w.child.pid) : null);
    fs.writeFileSync(s.file('release'), '1');
    const { code } = await w.finish();
    assert.equal(code, 0, s.log());
    assert.equal(fs.existsSync(s.file('config.launcher-pid')), false);
    await assertNothingLeft(s, w);
  });

  test('a daemon bundle that is missing ends the watchdog with 1 and an error that says what to do; nothing is started', async () => {
    const s = scenario();
    const lonely = path.join(root, `lonely-${path.basename(s.configDir)}`);
    fs.mkdirSync(lonely);
    fs.copyFileSync(watchdogBundle, path.join(lonely, 'orchestrator-watchdog.cjs'));
    const w = startWatchdog(s, { dist: path.join(lonely, 'orchestrator-watchdog.cjs') });
    const { code } = await w.finish();
    assert.equal(code, 1);
    assert.equal(s.starts().length, 0);
    assert.match(s.log(), /\[ERROR\] \[launcher\] cannot find the daemon bundle .*orchestrator\.cjs.*npm install -g @wadeck-app\/orchestrator-cli/);
    assert.equal(fs.existsSync(s.file('config.launcher-pid')), false);
    await assertNothingLeft(s, w);
  });

  test('a bundle that is replaced between two starts is the one the second start runs (looked up at every start)', async () => {
    const s = scenario();
    const dist = path.join(root, `swap-${path.basename(s.configDir)}`);
    fs.mkdirSync(dist);
    fs.copyFileSync(watchdogBundle, path.join(dist, 'orchestrator-watchdog.cjs'));
    const daemon = path.join(dist, 'orchestrator.cjs');
    // v1 asks for a restart and, as an update would, replaces the bundle under the same path with one that records itself and exits 0.
    fs.writeFileSync(daemon, `
      const fs = require('node:fs'); const path = require('node:path');
      const dir = process.env.ORCH_CONFIG_DIR;
      fs.appendFileSync(path.join(dir, 'versions.log'), 'v1\\n');
      fs.writeFileSync(${JSON.stringify(daemon)}, "require('node:fs').appendFileSync(require('node:path').join(process.env.ORCH_CONFIG_DIR, 'versions.log'), 'v2\\\\n');");
      fs.writeFileSync(path.join(dir, 'config.restart'), '1');
    `);
    const w = startWatchdog(s, { dist: path.join(dist, 'orchestrator-watchdog.cjs') });
    const { code } = await w.finish();
    assert.equal(code, 0, s.log());
    assert.equal(readIf(s.file('versions.log')), 'v1\nv2\n', s.log());
    await assertNothingLeft(s, w);
  });

  test('malformed ORCH_WATCHDOG_DELAYS_MS makes the watchdog fail loudly: exit 1, the variable named in the log, no daemon started', async () => {
    const s = scenario();
    const w = startWatchdog(s, { delays: 'two,seconds' });
    const { code } = await w.finish();
    assert.equal(code, 1);
    assert.equal(s.starts().length, 0);
    assert.match(s.log(), /\[ERROR\] \[launcher\] ORCH_WATCHDOG_DELAYS_MS="two" is not valid.*Unset ORCH_WATCHDOG_DELAYS_MS/);
    await assertNothingLeft(s, w);
  });

  test('malformed ORCH_WATCHDOG_WINDOW_MS makes the watchdog fail loudly too', async () => {
    const s = scenario();
    const w = startWatchdog(s, { window: '10m' });
    const { code } = await w.finish();
    assert.equal(code, 1);
    assert.match(s.log(), /ORCH_WATCHDOG_WINDOW_MS="10m" is not valid/);
    await assertNothingLeft(s, w);
  });

  // The daemon side of ORCH_WATCHDOG_PID with real processes: the fake daemon (real pid-watch module) is started by the test, not by
  // the watchdog, so nothing ties its life to the "watchdog" (a sleeping process that the test kills).
  test('the daemon stops by itself, exiting 0 with no sentinel, once the process named by ORCH_WATCHDOG_PID is gone', async () => {
    const s = scenario();
    const sleeper = path.join(root, 'sleeper.cjs');
    fs.writeFileSync(sleeper, 'setInterval(() => {}, 1000);\n');
    const stand = spawn(process.execPath, [sleeper], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { stand.once('spawn', resolve); stand.once('error', reject); });
    const daemon = spawn(process.execPath, [path.join(distDir, 'orchestrator.cjs'), s.configDir], {
      stdio: 'ignore', windowsHide: true,
      env: { ...process.env, ORCH_CONFIG_DIR: s.configDir, FAKE_DAEMON_PLAN: 'watch', ORCH_WATCHDOG_PID: String(stand.pid) },
    });
    const daemonExit = new Promise((resolve) => daemon.once('exit', (code, signal) => resolve({ code, signal })));
    cleanups.push(async () => {
      for (const p of [stand, daemon]) {
        try { p.kill('SIGKILL'); } catch { /* gone */ }
      }
    });
    await until('the daemon to start watching', () => /watching the watchdog/.test(readIf(s.file('watch.log'))));
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(alive(daemon.pid), true, 'the daemon must stay up while its watchdog is alive');
    stand.kill('SIGKILL');
    const result = await Promise.race([daemonExit, new Promise((_, reject) => { setTimeout(() => reject(new Error(`the daemon did not stop after the loss of its watchdog\n${readIf(s.file('watch.log'))}`)), 15_000).unref(); })]);
    assert.deepEqual(result, { code: 0, signal: null });
    assert.equal(fs.existsSync(s.file('watch-gone')), true);
    assert.equal(fs.existsSync(s.file('config.restart')), false, 'a stop with no sentinel is what keeps anything from restarting it');
    assert.match(readIf(s.file('watch.log')), /is gone: stopping the daemon/);
  });

  if (process.platform === 'win32') {
    // What the Go launcher's Job Object gave. Observed on this host (probe, 2026-11-22): a Node parent gets it too, because libuv
    // puts every child that is not detached in a kill-on-close job. The daemon the watchdog starts is such a child.
    test('Windows: killing the watchdog takes the daemon down with it; no node process is left', async () => {
      const s = scenario();
      const w = startWatchdog(s, { plan: 'wait' });
      await until('the daemon to start', () => s.starts().length === 1);
      const [start] = s.starts();
      assert.equal(start.watchdogPid, String(w.child.pid));
      w.child.kill('SIGKILL');
      await w.exited;
      await assertNothingLeft(s, w);
    });
  } else {
    test('POSIX: a SIGTERM is forwarded to the daemon, the watchdog exits with its code and does not restart it', async () => {
      const s = scenario();
      const w = startWatchdog(s, { plan: 'wait,exit:0' });
      await until('the daemon to start', () => s.starts().length === 1);
      w.child.kill('SIGTERM');
      const { code } = await w.finish();
      assert.equal(fs.existsSync(s.file('got-sigterm')), true, `the daemon never got the signal\n${s.log()}`);
      assert.equal(code, 143, s.log());
      assert.equal(s.starts().length, 1, 'a stop signal must not restart the daemon');
      assert.equal(fs.existsSync(s.file('crashed.json')), false, 'a forwarded stop is not a crash');
      assert.doesNotMatch(s.log(), /crashed/);
      await assertNothingLeft(s, w);
    });
  }
});
