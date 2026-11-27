'use strict';

// A registered start-at-login entry names paths (node, the bootstrap, the node of its PATH). A node or npm prefix change can
// leave it naming paths that are gone: the daemon then does not start at the next login, and the reason sits in a launcher log.
// inspectStartupEntry reads the entry back; repairStartupEntry re-registers it, only when it is broken. The paths the entry names
// are a fake file set (POSIX-style strings on any host); only the unit and its enable link are real files in a temp directory.
// An entry that still names the removed Go launcher is covered here and in startup-watchdog.test.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { buildSystemdUnit, inspectStartupEntry, repairStartupEntry } = require('../src/startup');
const { BOOTSTRAP_SOURCE, bootstrapArgs } = require('../src/start-bootstrap');

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-entry-'));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });

/** The files that "exist" for the entry's paths. */
function fakeFiles(...paths) {
  const set = new Set(paths);
  return { set, isFile: (p) => set.has(p), realpath: (p) => p };
}

const readBootstrap = () => Buffer.from(BOOTSTRAP_SOURCE, 'utf8');

/** A registered Linux entry for the watchdog: the unit text is real, the paths it names are fake. */
function linux({ base = '/opt/a' } = {}) {
  const node      = `${base}/bin/node`;
  const watchdog  = `${base}/lib/orchestrator-watchdog.cjs`;
  const nodeBin   = `${base}/bin`;
  const args      = bootstrapArgs({ node, configDir: '/cfg', hint: watchdog });
  const bootstrap = args[1];
  const fake      = fakeFiles(node, bootstrap, watchdog);
  const root      = tmp();
  const unitPath  = path.join(root, 'systemd', 'user', 'orchestrator.service');
  const wants     = path.join(root, 'systemd', 'user', 'default.target.wants', 'orchestrator.service');
  fs.mkdirSync(path.dirname(wants), { recursive: true });
  fs.writeFileSync(unitPath, buildSystemdUnit(args, '/cfg', [nodeBin, '/usr/bin']));
  fs.writeFileSync(wants, '');
  const deps = {
    platform: 'linux', unitPath, watchdogEntry: watchdog, nodeBinDir: nodeBin, readFile: readBootstrap,
    isFile: fake.isFile, realpath: fake.realpath, validateTarget: () => null,
  };
  return { deps, node, bootstrap, watchdog, nodeBin, fake };
}

describe('inspectStartupEntry on Linux', () => {
  test('an entry whose paths exist and are this install\'s is ok', () => {
    const { deps } = linux();
    assert.deepEqual(inspectStartupEntry('/cfg', deps), { state: 'ok', problems: [] });
  });

  test('paths with a blank, a percent sign and a dollar survive the unit quoting round trip', () => {
    const { deps } = linux({ base: '/opt/my install 100% $HOME' });
    assert.deepEqual(inspectStartupEntry('/cfg', deps), { state: 'ok', problems: [] });
  });

  test('nothing registered for this config dir: absent', () => {
    const { deps } = linux();
    assert.equal(inspectStartupEntry('/another-cfg', deps).state, 'absent');
    assert.equal(inspectStartupEntry('/cfg', { ...deps, unitPath: path.join(tmp(), 'none.service') }).state, 'absent');
  });

  test('a node that is gone is broken, and the path is named', () => {
    const { deps, node, fake } = linux();
    fake.set.delete(node);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(node)), JSON.stringify(r));
  });

  test('a bootstrap that is gone is broken, and the path is named', () => {
    const { deps, bootstrap, fake } = linux();
    fake.set.delete(bootstrap);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(bootstrap)), JSON.stringify(r));
  });

  test('a PATH with no node left is broken, and the PATH is named', () => {
    const { deps, nodeBin, fake } = linux();
    fake.set.delete(`${nodeBin}/node`);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => /no node/.test(p) && p.includes(nodeBin)), JSON.stringify(r));
  });

  test('an entry that works but starts under another node than this one is a drift, naming both', () => {
    const { deps, nodeBin } = linux();
    const r = inspectStartupEntry('/cfg', { ...deps, nodeBinDir: '/opt/b/bin' });
    assert.equal(r.state, 'drift');
    assert.ok(r.problems.some((p) => p.includes(nodeBin) && p.includes('/opt/b/bin')), JSON.stringify(r));
  });

  test('an entry for the watchdog over an install without it is broken and says to re-install', () => {
    const { deps } = linux();
    const r = inspectStartupEntry('/cfg', { ...deps, watchdogEntry: null });
    assert.equal(r.state, 'broken');
    assert.match(r.problems.join(), /npm install -g @wadeck-app\/orchestrator-cli, then run orch install/);
  });

  // remove one release after phase C, with the detection it covers
  test('an entry that still names the removed Go launcher is outdated whatever its files, with nothing about the launcher checked', () => {
    const { deps, fake } = linux();
    fs.writeFileSync(deps.unitPath, buildSystemdUnit(['/gone/launcher', '/cfg'], '/cfg', ['/gone/bin', '/usr/bin']));
    assert.equal(fake.isFile('/gone/launcher'), false);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'outdated');
    assert.match(r.problems.join(), /still starts the Go launcher, which was removed/);
  });

  test('an entry that names the Go launcher over an install with no watchdog is broken and says to re-install', () => {
    const { deps } = linux();
    fs.writeFileSync(deps.unitPath, buildSystemdUnit(['/gone/launcher', '/cfg'], '/cfg', ['/gone/bin', '/usr/bin']));
    const r = inspectStartupEntry('/cfg', { ...deps, watchdogEntry: null });
    assert.equal(r.state, 'broken');
    assert.match(r.problems.join(), /npm install -g @wadeck-app\/orchestrator-cli, then run orch install/);
  });
});

describe('inspectStartupEntry on macOS', () => {
  function plist({ nodeExists = true } = {}) {
    const node      = '/opt/a/bin/node';
    const nodeBin   = '/opt/a/bin';
    const watchdog  = '/opt/a/lib/orchestrator-watchdog.cjs';
    const args      = bootstrapArgs({ node, configDir: '/cfg', hint: watchdog });
    const fake      = fakeFiles(args[1], watchdog, ...(nodeExists ? [node] : []));
    const plistPath = path.join(tmp(), 'com.wadeck.orchestrator.plist');
    fs.writeFileSync(plistPath, `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${nodeBin}:/usr/bin</string>
    <key>ORCH_CONFIG_DIR</key>
    <string>/cfg</string>
  </dict>
</dict></plist>
`);
    return { deps: { platform: 'darwin', plistPath, watchdogEntry: watchdog, nodeBinDir: nodeBin, readFile: readBootstrap, isFile: fake.isFile, realpath: fake.realpath }, node };
  }

  test('a plist whose paths exist is ok', () => {
    assert.equal(inspectStartupEntry('/cfg', plist().deps).state, 'ok');
  });

  test('a plist whose node is gone is broken', () => {
    const { deps, node } = plist({ nodeExists: false });
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(node)), JSON.stringify(r));
  });
});

describe('inspectStartupEntry on Windows', () => {
  // remove one release after phase C: the Run value of the removed Go launcher
  function registry(launcher) {
    const exec = () => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Orchestrator (/cfg)    REG_SZ    "${launcher}" "/cfg"\r\n`;
    return { platform: 'win32', exec, isFile: () => false };
  }

  test('a Run value that names the removed Go launcher is outdated whether or not the file is there', () => {
    const r = inspectStartupEntry('/cfg', { ...registry('C:\\cfg\\launcher.exe'), watchdogEntry: 'C:\\pkg\\orchestrator-watchdog.cjs' });
    assert.equal(r.state, 'outdated');
  });

  test('the same value over an install with no watchdog is broken and says to re-install', () => {
    const r = inspectStartupEntry('/cfg', { ...registry('C:\\cfg\\launcher.exe'), watchdogEntry: null });
    assert.equal(r.state, 'broken');
    assert.match(r.problems.join(), /npm install -g @wadeck-app\/orchestrator-cli, then run orch install/);
  });
});

describe('repairStartupEntry', () => {
  /** systemctl double plus the login-shell double the unit writer needs. */
  function repairDeps(base, calls) {
    return {
      ...base,
      exec: (cmd, args) => { calls.push([cmd, ...args]); return ''; },
      linuxPath: { runShell: () => ({ status: 1, stdout: '', stderr: '' }), shellEnv: '/bin/sh', isExecutableFile: () => true, home: '/home/t', nodeBinDir: base.nodeBinDir, env: {} },
    };
  }

  test('a broken entry is written again with this install\'s paths, and is ok afterwards', () => {
    const { deps, node, fake } = linux();
    fake.set.delete(node);
    // The node and the watchdog of the new install; its bootstrap is the one the repair writes.
    const newNode = '/opt/b/bin/node';
    const newWatchdog = '/opt/b/lib/orchestrator-watchdog.cjs';
    // programArguments is the seam that keeps the repair from writing a bootstrap into the real '/cfg'.
    const newArgs = bootstrapArgs({ node: newNode, configDir: '/cfg', hint: newWatchdog });
    fake.set.add(newNode);
    fake.set.add(newWatchdog);
    fake.set.add(newArgs[1]);
    const calls = [];
    const d = repairDeps({ ...deps, watchdogEntry: newWatchdog, nodeBinDir: '/opt/b/bin', programArguments: newArgs }, calls);
    d.linuxPath.fallbackEntries = ['/opt/b/bin'];
    const { report, repair } = repairStartupEntry('/cfg', d);
    assert.equal(report.state, 'broken');
    assert.equal(repair.ok, true, JSON.stringify(repair));
    assert.ok(calls.some((c) => c.includes('enable')), JSON.stringify(calls));
    const after = inspectStartupEntry('/cfg', d);
    assert.equal(after.state, 'ok', JSON.stringify(after));
  });

  test('an entry that is ok or only drifts is left alone: nothing is run, nothing is written', () => {
    const { deps } = linux();
    const before = fs.readFileSync(deps.unitPath, 'utf8');
    const calls = [];
    for (const d of [deps, { ...deps, nodeBinDir: '/opt/b/bin' }]) {
      const { repair } = repairStartupEntry('/cfg', repairDeps(d, calls));
      assert.equal(repair, null);
    }
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(deps.unitPath, 'utf8'), before);
  });
});
