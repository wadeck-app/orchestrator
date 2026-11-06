'use strict';

// A registered start-at-login entry names paths (launcher, daemon bundle, the node of its PATH). A node or npm prefix change can
// leave it naming paths that are gone: the daemon then does not start at the next login, and the reason sits in a launcher log.
// inspectStartupEntry reads the entry back; repairStartupEntry re-registers it, only when it is broken. The paths the entry names
// are a fake file set (POSIX-style strings on any host); only the unit and its enable link are real files in a temp directory.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { buildSystemdUnit, inspectStartupEntry, repairStartupEntry } = require('../src/startup');

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

/** A registered Linux entry: the unit text is real, the paths it names are fake. */
function linux({ base = '/opt/a' } = {}) {
  const launcher = `${base}/launcher`;
  const bundle   = `${base}/lib/orchestrator.cjs`;
  const nodeBin  = `${base}/bin`;
  const fake     = fakeFiles(launcher, bundle, `${nodeBin}/node`);
  const root     = tmp();
  const unitPath = path.join(root, 'systemd', 'user', 'orchestrator.service');
  const wants    = path.join(root, 'systemd', 'user', 'default.target.wants', 'orchestrator.service');
  fs.mkdirSync(path.dirname(wants), { recursive: true });
  fs.writeFileSync(unitPath, buildSystemdUnit([launcher, '/cfg'], '/cfg', [nodeBin, '/usr/bin'], bundle));
  fs.writeFileSync(wants, '');
  const deps = { platform: 'linux', unitPath, daemonEntry: bundle, nodeBinDir: nodeBin, isFile: fake.isFile, realpath: fake.realpath, validateTarget: () => null };
  return { deps, launcher, bundle, nodeBin, fake };
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

  test('a daemon bundle that is gone is broken, and the path is named', () => {
    const { deps, bundle, fake } = linux();
    fake.set.delete(bundle);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(bundle)), JSON.stringify(r));
  });

  test('a PATH with no node left is broken, and the PATH is named', () => {
    const { deps, nodeBin, fake } = linux();
    fake.set.delete(`${nodeBin}/node`);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => /no node/.test(p) && p.includes(nodeBin)), JSON.stringify(r));
  });

  test('a launcher that is gone is broken', () => {
    const { deps, launcher, fake } = linux();
    fake.set.delete(launcher);
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(launcher)), JSON.stringify(r));
  });

  test('an entry that works but starts another install than this one is a drift, naming both', () => {
    const { deps, bundle, fake } = linux();
    fake.set.add('/opt/b/lib/orchestrator.cjs');
    const r = inspectStartupEntry('/cfg', { ...deps, daemonEntry: '/opt/b/lib/orchestrator.cjs', nodeBinDir: '/opt/b/bin' });
    assert.equal(r.state, 'drift');
    assert.ok(r.problems.some((p) => p.includes(bundle) && p.includes('/opt/b/lib/orchestrator.cjs')), JSON.stringify(r));
    assert.ok(r.problems.some((p) => p.includes('/opt/b/bin')), JSON.stringify(r));
  });
});

describe('inspectStartupEntry on macOS', () => {
  function plist({ bundleExists = true } = {}) {
    const launcher = '/Users/t/.config/orchestrator/launcher';
    const bundle   = '/opt/a/lib/orchestrator.cjs';
    const nodeBin  = '/opt/a/bin';
    const fake     = fakeFiles(launcher, `${nodeBin}/node`, ...(bundleExists ? [bundle] : []));
    const plistPath = path.join(tmp(), 'com.wadeck.orchestrator.plist');
    fs.writeFileSync(plistPath, `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>
    <string>${launcher}</string>
    <string>/cfg</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${nodeBin}:/usr/bin</string>
    <key>ORCH_CONFIG_DIR</key>
    <string>/cfg</string>
    <key>LAUNCHER_BUNDLE_OVERRIDE</key>
    <string>${bundle}</string>
  </dict>
</dict></plist>
`);
    return { deps: { platform: 'darwin', plistPath, daemonEntry: bundle, nodeBinDir: nodeBin, isFile: fake.isFile, realpath: fake.realpath }, bundle };
  }

  test('a plist whose paths exist is ok', () => {
    assert.equal(inspectStartupEntry('/cfg', plist().deps).state, 'ok');
  });

  test('a plist whose bundle is gone is broken', () => {
    const { deps, bundle } = plist({ bundleExists: false });
    const r = inspectStartupEntry('/cfg', deps);
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes(bundle)), JSON.stringify(r));
  });
});

describe('inspectStartupEntry on Windows', () => {
  function registry(launcher, exists) {
    const exec = () => `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    Orchestrator (/cfg)    REG_SZ    "${launcher}" "/cfg"\r\n`;
    return { platform: 'win32', exec, daemonEntry: null, isFile: (p) => exists && p === launcher };
  }

  test('a registered launcher that exists is ok', () => {
    assert.equal(inspectStartupEntry('/cfg', registry('C:\\cfg\\launcher.exe', true)).state, 'ok');
  });

  test('a registered launcher that is gone is broken', () => {
    const r = inspectStartupEntry('/cfg', registry('C:\\cfg\\launcher.exe', false));
    assert.equal(r.state, 'broken');
    assert.ok(r.problems.some((p) => p.includes('C:\\cfg\\launcher.exe')), JSON.stringify(r));
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
    const { deps, bundle, fake } = linux();
    fake.set.delete(bundle);
    // The node of the new install, and its bundle and launcher.
    fake.set.add('/opt/b/lib/orchestrator.cjs');
    fake.set.add('/opt/b/launcher');
    fake.set.add('/opt/b/bin/node');
    const calls = [];
    const d = repairDeps({ ...deps, daemonEntry: '/opt/b/lib/orchestrator.cjs', nodeBinDir: '/opt/b/bin', programArguments: ['/opt/b/launcher', '/cfg'] }, calls);
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
    for (const d of [deps, { ...deps, daemonEntry: '/opt/b/lib/orchestrator.cjs' }]) {
      const { repair } = repairStartupEntry('/cfg', repairDeps(d, calls));
      assert.equal(repair, null);
    }
    assert.deepEqual(calls, []);
    assert.equal(fs.readFileSync(deps.unitPath, 'utf8'), before);
  });
});
