'use strict';

// The REAL bootstrap (src/start-bootstrap.ts) started with a real node, on a FAKE package layout in a temp dir, with a fake
// watchdog that records its pid, argv and environment. It proves what the login entry relies on: the bootstrap finds the watchdog
// where the install really is, runs it IN-PROCESS (the pid of the process the entry started is the watchdog's pid, so there is one
// resident node and config.launcher-pid is right), hands it exactly [configDir], and says why when it cannot.
//
// The node is a hard link (or copy) of this node placed in a temp dir: the machine running the test may have the real
// @wadeck-app/orchestrator-cli installed next to its node, and the bootstrap must never be able to find THAT one (it would start the
// real watchdog on a throwaway config dir). The environment given to the child has no npm prefix, no override and an empty %APPDATA%.
// Windows only, at the end: the Run value typed into cmd.exe starts the hidden script, which starts the bootstrap.
// The spawn options are asserted, the absence of a console window is not observable from here.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const { BOOTSTRAP_FILE, BOOTSTRAP_SOURCE, START_VBS_FILE, writeIfChanged, decodeVbs, parseStartVbs } = require('../src/start-bootstrap');
const { enableStartup } = require('../src/startup');
const { watchdogSpawnSpec } = require('../src/watchdog/launch');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-boot-e2e-'));
const FAKE_WATCHDOG = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = process.argv[2];
fs.writeFileSync(path.join(cfg, 'wd.json'), JSON.stringify({
  pid: process.pid, argv: process.argv.slice(2), execPath: process.execPath, dirname: __dirname,
  configDirEnv: process.env.ORCH_CONFIG_DIR ?? null,
}));
fs.writeFileSync(path.join(cfg, 'config.launcher-pid'), String(process.pid));
const timer = setInterval(() => {
  if (fs.existsSync(path.join(cfg, 'release'))) { clearInterval(timer); process.exit(0); }
}, 40);
`;

let nodeCopy;
before(() => {
  const dir = fs.mkdtempSync(path.join(root, 'nodebin-'));
  nodeCopy = path.join(dir, path.basename(process.execPath));
  try {
    fs.linkSync(process.execPath, nodeCopy);
  } catch {
    // No hard link across volumes or without the right on the file: a copy, once.
    fs.copyFileSync(process.execPath, nodeCopy);
  }
  assert.ok(fs.existsSync(nodeCopy), `the test node ${nodeCopy} was not created`);
});

const pids = [];
afterEach(async () => {
  while (pids.length > 0) {
    const pid = pids.pop();
    if (alive(pid)) {
      try { process.kill(pid); } catch { /* gone meanwhile */ }
    }
  }
});
after(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

async function until(what, predicate, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) { return value; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

/** The environment of a login: no npm prefix, no override, an empty %APPDATA%, nothing of ORCH_*. */
function loginEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(npm_config_prefix|LAUNCHER_BUNDLE_OVERRIDE|APPDATA)$/i.test(k) || k.startsWith('ORCH_')) { continue; }
    env[k] = v;
  }
  return { ...env, APPDATA: fs.mkdtempSync(path.join(root, 'appdata-')), ...extra };
}

/** <modulesDir>/@wadeck-app/orchestrator-cli/dist with the fake watchdog (and a daemon next to it). */
function installIn(modulesDir) {
  const dist = path.join(modulesDir, '@wadeck-app', 'orchestrator-cli', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'orchestrator-watchdog.cjs'), FAKE_WATCHDOG);
  fs.writeFileSync(path.join(dist, 'orchestrator.cjs'), '// fake daemon\n');
  return dist;
}

function scenario() {
  const configDir = fs.mkdtempSync(path.join(root, 'cfg dir é '));
  writeIfChanged(path.join(configDir, BOOTSTRAP_FILE), BOOTSTRAP_SOURCE);
  const read = (name) => path.join(configDir, name);
  return {
    configDir, bootstrap: read(BOOTSTRAP_FILE),
    wd: () => (fs.existsSync(read('wd.json')) ? JSON.parse(fs.readFileSync(read('wd.json'), 'utf8')) : null),
    release: () => fs.writeFileSync(read('release'), ''),
    log: () => {
      const dir = read('logs');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}-launcher\.log$/.test(f)).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('') : '';
    },
  };
}

/** Starts `node bootstrap <configDir> [hint]` the way `orch start` starts the watchdog: detached, hidden, no stdio. */
function startLogin(s, { env, hint, node = nodeCopy }) {
  const spec = watchdogSpawnSpec({ execPath: node, watchdogPath: s.bootstrap, configDir: s.configDir, env });
  assert.equal(spec.options.windowsHide, true);
  assert.equal(spec.options.detached, true);
  assert.equal(spec.options.stdio, 'ignore');
  // The environment is the login's own: the spec's copy has its LAUNCHER_BUNDLE_OVERRIDE stripped, which is orch start's rule, not the login's.
  const child = spawn(node, [s.bootstrap, s.configDir, ...(hint ? [hint] : [])], { ...spec.options, env });
  pids.push(child.pid);
  child.unref();
  return child;
}

async function assertRunsWatchdog(s, child, { dist }) {
  const wd = await until('the fake watchdog to start', () => s.wd());
  assert.equal(wd.pid, child.pid, 'the process the entry started IS the watchdog: one resident node, no second process');
  assert.equal(Number(fs.readFileSync(path.join(s.configDir, 'config.launcher-pid'), 'utf8')), child.pid);
  assert.deepEqual(wd.argv, [s.configDir], 'the watchdog gets the config dir and nothing else (not the hint)');
  assert.equal(wd.execPath, nodeCopy);
  assert.equal(fs.realpathSync(wd.dirname), fs.realpathSync(dist));
  assert.ok(alive(child.pid));
  assert.match(s.log(), /\[ INFO\] \[launcher\] start at login: running .*orchestrator-watchdog\.cjs \(found via /);
  s.release();
  const [code] = await once(child, 'exit');
  assert.equal(code, 0);
}

describe('bootstrap e2e: the process the login starts becomes the watchdog', () => {
  test('modules next to node (Windows installer, nvm-windows): found, in-process, argv is [configDir]', async () => {
    const s = scenario();
    const dist = installIn(path.join(path.dirname(nodeCopy), 'node_modules'));
    const child = startLogin(s, { env: loginEnv() });
    await assertRunsWatchdog(s, child, { dist });
    assert.match(s.log(), /found via node_modules next to/);
    fs.rmSync(path.join(path.dirname(nodeCopy), 'node_modules'), { recursive: true, force: true });
  });

  test('global prefix OUTSIDE node\'s folder (npm prefix of the environment) is found', async () => {
    const s = scenario();
    const prefix = fs.mkdtempSync(path.join(root, 'prefix-'));
    const dist = installIn(process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules'));
    const child = startLogin(s, { env: loginEnv({ npm_config_prefix: prefix }) });
    await assertRunsWatchdog(s, child, { dist });
    assert.match(s.log(), /found via npm prefix/);
  });

  // (%APPDATA%\npm, the Windows default prefix, is in the Windows block below: the variable means nothing elsewhere.)
  const appDataTest = process.platform === 'win32' ? test : () => {};
  appDataTest('%APPDATA%\\npm, the Windows default prefix, is found', async () => {
    const s = scenario();
    const appData = fs.mkdtempSync(path.join(root, 'roaming-'));
    const dist = installIn(path.join(appData, 'npm', 'node_modules'));
    const child = startLogin(s, { env: loginEnv({ APPDATA: appData }) });
    await assertRunsWatchdog(s, child, { dist });
    assert.match(s.log(), /found via the npm folder of %APPDATA%/);
  });

  test('LAUNCHER_BUNDLE_OVERRIDE: the watchdog next to the named daemon bundle', async () => {
    const s = scenario();
    const dist = installIn(fs.mkdtempSync(path.join(root, 'checkout-')));
    const child = startLogin(s, { env: loginEnv({ LAUNCHER_BUNDLE_OVERRIDE: path.join(dist, 'orchestrator.cjs') }) });
    await assertRunsWatchdog(s, child, { dist });
    assert.match(s.log(), /found via LAUNCHER_BUNDLE_OVERRIDE/);
  });

  test('only the install seen when the entry was written is left: used, and said', async () => {
    const s = scenario();
    const dist = installIn(fs.mkdtempSync(path.join(root, 'seen-')));
    const child = startLogin(s, { env: loginEnv(), hint: path.join(dist, 'orchestrator-watchdog.cjs') });
    await assertRunsWatchdog(s, child, { dist });
    assert.match(s.log(), /found via the install seen when the entry was written/);
  });

  test('nothing installed: exit code 1, an actionable line in the launcher log and on stderr, no watchdog started', () => {
    const s = scenario();
    const r = spawnSync(nodeCopy, [s.bootstrap, s.configDir, path.join(root, 'gone', 'orchestrator-watchdog.cjs')], { env: loginEnv(), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.equal(s.wd(), null);
    assert.match(s.log(), /\[ERROR\] \[launcher\] start at login: cannot find orchestrator-watchdog\.cjs of @wadeck-app\/orchestrator-cli \(looked in: .*\)\. Install it with: npm install -g @wadeck-app\/orchestrator-cli, then run: orch install/);
    assert.match(r.stderr, /\[ERROR\] \[launcher\] start at login: cannot find/);
  });

  test('no config dir given: exit code 2 and the usage on stderr', () => {
    const s = scenario();
    const r = spawnSync(nodeCopy, [s.bootstrap], { env: loginEnv(), encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no config dir given\. Usage: node orchestrator-start\.cjs <configDir>/);
  });
});

// Windows only by nature (wscript.exe, cmd.exe): declared under the platform test instead of being skipped inside a test.
if (process.platform === 'win32') {
  describe('Windows e2e: the Run value typed into cmd.exe starts the hidden script, which starts the bootstrap', () => {
    function regDouble() {
      const store = new Map();
      return {
        store,
        exec: (cmd, args) => {
          if (args[0] === 'add') { store.set(args[3], args[args.indexOf('/d') + 1]); }
          return '';
        },
      };
    }

    test('wscript //nologo <vbs>: the fake watchdog runs in ONE node whose pid is in config.launcher-pid', async () => {
      const s = scenario();
      const dist = installIn(fs.mkdtempSync(path.join(root, 'seen-')));
      const watchdogEntry = path.join(dist, 'orchestrator-watchdog.cjs');
      const reg = regDouble();
      const r = enableStartup(s.configDir, { platform: 'win32', exec: reg.exec, watchdogEntry, nodePath: nodeCopy });
      assert.equal(r.ok, true, JSON.stringify(r));
      const value = [...reg.store.values()][0];
      assert.equal(value, `wscript.exe //nologo "${path.join(s.configDir, START_VBS_FILE)}"`);
      const args = parseStartVbs(decodeVbs(fs.readFileSync(path.join(s.configDir, START_VBS_FILE))));
      assert.deepEqual(args, [nodeCopy, s.bootstrap, s.configDir, watchdogEntry]);

      // What a person pastes into cmd.exe: exactly the value, no extra quoting.
      const shell = spawnSync('cmd.exe', ['/c', value], { env: loginEnv(), windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
      assert.equal(shell.status, 0, `${shell.stdout}${shell.stderr}`);
      const wd = await until('the watchdog started through wscript', () => s.wd());
      pids.push(wd.pid);
      assert.equal(Number(fs.readFileSync(path.join(s.configDir, 'config.launcher-pid'), 'utf8')), wd.pid);
      assert.deepEqual(wd.argv, [s.configDir]);
      assert.equal(wd.execPath, nodeCopy);
      assert.ok(alive(wd.pid));
      s.release();
      await until('the watchdog to exit', () => !alive(wd.pid));
    });

    test('a baked node that is gone: no modal dialog, an ERROR line in the launcher log that says what to run', async () => {
      const s = scenario();
      const dist = installIn(fs.mkdtempSync(path.join(root, 'seen-')));
      const reg = regDouble();
      const gone = path.join(root, 'removed-node', 'node.exe');
      assert.equal(enableStartup(s.configDir, { platform: 'win32', exec: reg.exec, watchdogEntry: path.join(dist, 'orchestrator-watchdog.cjs'), nodePath: gone }).ok, true);
      const shell = spawnSync('cmd.exe', ['/c', [...reg.store.values()][0]], { env: loginEnv(), windowsVerbatimArguments: true, windowsHide: true, encoding: 'utf8', timeout: 20_000 });
      assert.equal(shell.status, 0, `${shell.stdout}${shell.stderr}`);
      await until('the error line', () => /start at login: wscript could not start node \(.+\)\. The node path baked in the login entry may be gone: run orch install/.test(s.log()));
      assert.match(s.log(), /^\[\d\d:\d\d:\d\d\] \[ERROR\] \[launcher\] /);
      assert.equal(s.wd(), null);
    });
  });
}
