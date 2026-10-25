'use strict';

// ORCH_NO_TRAY=1: no tray process, for development and tests only.
//
// Every daemon a test started launched a real orchestrator-tray.exe, and the test then killed the daemon tree by force,
// which leaves a ghost icon in the Windows taskbar (15-25 of them on 2026-10-25). The suite's preload now sets the
// variable for the whole run, and the daemon says once, in its log, that it is off, so a variable left set by mistake
// is never silent.
const { test, describe, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
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
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeManager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-tray-'));
  dirs.push(dir);
  const scheduler = Object.assign(new EventEmitter(), { runningCount: () => 0 });
  const mgr = new TrayManager(dir, scheduler, { getAll: () => ({}) }, { list: () => [] }, '0.0.0-test', undefined, null);
  const logs = [];
  mgr.on('log', (line) => logs.push(line));
  const spawned = [];
  mgr._createTray = () => { spawned.push(1); throw new Error('a tray was created'); };
  mgr._findBinary = () => path.join(dir, 'fake-tray');
  return { mgr, dir, logs, spawned };
}

/** start() registers a process-wide 'exit' hook; the ones it adds are taken off again. */
async function start(mgr) {
  const before = new Set(process.listeners('exit'));
  await mgr.start();
  const added = process.listeners('exit').filter((l) => !before.has(l));
  for (const l of added) { process.removeListener('exit', l); }
  return added.length;
}

describe('TrayManager.start with ORCH_NO_TRAY=1', () => {
  test('starts nothing, kills nothing, registers nothing, and says so once', async () => {
    process.env.ORCH_NO_TRAY = '1';
    const calls = [];
    mock.method(childProcess, 'execFileSync', (...args) => { calls.push(args); return Buffer.alloc(0); });
    const { mgr, dir, logs, spawned } = makeManager();
    fs.writeFileSync(path.join(dir, 'config.tray-pid'), '31337');

    const hooks = await start(mgr);

    assert.deepEqual(spawned, [], 'a tray process was started');
    // The constructor reads the start-at-login entry (reg query); that is not about the tray process.
    const trayCalls = calls.filter(([cmd]) => ['taskkill', 'tasklist', 'pkill', 'ps'].includes(cmd));
    assert.deepEqual(trayCalls, [], 'a tray process was killed or looked up');
    assert.equal(hooks, 0, 'an exit hook was registered for a tray that does not exist');
    assert.equal(fs.readFileSync(path.join(dir, 'config.tray-pid'), 'utf8'), '31337', 'the pid file of a real tray was touched');
    assert.equal(logs.filter((l) => /tray disabled by ORCH_NO_TRAY/.test(l)).length, 1, logs.join(' | '));
    assert.equal(logs.length, 1, 'only that one line');
  });
});

describe('TrayManager.start without it', () => {
  for (const value of [undefined, '0']) {
    test(`ORCH_NO_TRAY=${value} starts the tray as before`, async () => {
      if (value === undefined) { delete process.env.ORCH_NO_TRAY; } else { process.env.ORCH_NO_TRAY = value; }
      const { mgr, logs } = makeManager();
      let spawnCalls = 0;
      mgr._spawnTray = async () => { spawnCalls++; };
      await start(mgr);
      assert.equal(spawnCalls, 1);
      assert.ok(!logs.some((l) => /ORCH_NO_TRAY/.test(l)), logs.join(' | '));
    });
  }

  test('a value other than 1 or 0 does not disable the tray, and is said', async () => {
    process.env.ORCH_NO_TRAY = 'true';
    const { mgr, logs } = makeManager();
    let spawnCalls = 0;
    mgr._spawnTray = async () => { spawnCalls++; };
    await start(mgr);
    assert.equal(spawnCalls, 1);
    assert.ok(logs.some((l) => /ORCH_NO_TRAY="true".*only "1" disables/.test(l)), logs.join(' | '));
  });
});

describe('the suite is set up so that no test starts a tray', () => {
  test('the preload set ORCH_NO_TRAY=1 for this run (children inherit it)', () => {
    assert.equal(process.env.ORCH_NO_TRAY, ORIGINAL);
    assert.equal(ORIGINAL, '1',
      'ORCH_NO_TRAY is not 1: run the suite with `npm test` (test/helpers/isolate-config-dir.js sets it), not with node --test alone');
  });

  test('a real daemon started like the tests start one launches no tray and writes no tray pid file', async () => {
    assert.equal(process.env.ORCH_NO_TRAY, '1', 'precondition: the preload variable');
    const entry = path.join(__dirname, '..', 'src', 'index.ts');
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-tray-daemon-'));
    dirs.push(configDir);
    const child = childProcess.spawn(process.execPath, ['--require', require.resolve('tsx/cjs'), entry, '--config-dir', configDir], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORCH_CONFIG_DIR: configDir, APP_CORE_CONFIG_DIR: path.join(configDir, 'no-app-core') },
    });
    let output = '';
    let markReady;
    const ready = new Promise((resolve) => { markReady = resolve; });
    const exited = new Promise((resolve) => { child.once('exit', resolve); });
    const onData = (d) => { output += d; if (/\[orchestrator\] daemon ready/.test(output)) { markReady(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    try {
      await Promise.race([ready, exited.then(() => { throw new Error(`the daemon exited before it was ready; it said:\n${output}`); })]);

      // "ready" is announced before the tray is started (index.ts), so the tray's own line is what is waited for: on the
      // log directory's change events, not on a delay.
      const appLogs = path.join(configDir, 'logs', 'app');
      const readDaemonLog = () => fs.readdirSync(appLogs).filter((f) => f.startsWith('daemon-'))
        .map((f) => fs.readFileSync(path.join(appLogs, f), 'utf8')).join('\n');
      const daemonLog = await new Promise((resolve, reject) => {
        const check = () => {
          const text = readDaemonLog();
          if (/tray disabled by ORCH_NO_TRAY/.test(text) || /\[tray\] (ready|systray)|starting tray-go/.test(text)) {
            clearTimeout(limit);
            clearInterval(backstop);
            watcher.close();
            resolve(text);
          }
        };
        const watcher = fs.watch(appLogs, check);
        // Windows does not always deliver a change event for an append (seen: the line was in the file, the watcher never
        // fired), so the condition is also re-read on a short interval, bounded by the same limit.
        const backstop = setInterval(check, 100);
        const limit = setTimeout(() => { watcher.close(); clearInterval(backstop); reject(new Error(`no tray line in the daemon log after 60 s:\n${readDaemonLog()}`)); }, 60_000);
        check();
      });
      assert.match(daemonLog, /tray disabled by ORCH_NO_TRAY/);
      assert.equal(fs.existsSync(path.join(configDir, 'config.tray-pid')), false, 'a tray pid file was written: a tray was started');
      assert.doesNotMatch(daemonLog, /starting tray-go|\[tray\] ready/, 'the tray ran');
      assert.doesNotMatch(output, /\[tray-go\]/);
    } finally {
      const { port } = JSON.parse(fs.readFileSync(path.join(configDir, 'config.port'), 'utf8'));
      const token = fs.readFileSync(path.join(configDir, 'health_token'), 'utf8').trim();
      await new Promise((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port, method: 'POST', path: '/quit', headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' } }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.end();
      });
      const limit = setTimeout(() => {
        if (process.platform === 'win32') {
          childProcess.spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      }, 60_000);
      await exited;
      clearTimeout(limit);
    }
  });
});
