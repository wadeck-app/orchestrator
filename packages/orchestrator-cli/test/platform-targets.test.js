'use strict';

// The list of platforms the orchestrator ships for lived in six places (the resolution tables of platform-binary.ts,
// generate/copy/publish-platform-packages, optionalDependencies, build-supervisor-binary.ts), and Linux was missing from
// all of them at once without anything failing: an npm install there could not even start the daemon. PLATFORM_TARGETS is
// the one table; this file makes every other place agree with it, so adding a platform is a change that fails until it is
// complete.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

const { PLATFORM_TARGETS, platformKeyOf, platformHasTray, nativeBinaryProblem, trayUnavailableMessage } = require('../src/platform-binary');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const KEYS = Object.keys(PLATFORM_TARGETS).sort();

describe('PLATFORM_TARGETS', () => {
  test('covers Windows, macOS and Linux, each with the architectures we build', () => {
    assert.deepEqual(KEYS, ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64']);
  });

  test('every target names its package after its key, and has a launcher and a supervisor', () => {
    for (const key of KEYS) {
      const t = PLATFORM_TARGETS[key];
      assert.equal(t.pkg, `@wadeck-app/orchestrator-cli-${key}`, key);
      assert.ok(t.launcherDev, `${key}: launcher`);
      assert.ok(t.supervisorDev, `${key}: supervisor`);
    }
  });

  test('only Windows and macOS have a tray: there is no Linux systray build', () => {
    assert.deepEqual(KEYS.filter((k) => PLATFORM_TARGETS[k].trayDev !== null), ['darwin-arm64', 'darwin-x64', 'win32-x64']);
    assert.equal(platformHasTray('linux'), false);
    assert.equal(platformHasTray('win32'), true);
    assert.equal(platformHasTray('darwin'), true);
  });

  test('platformKeyOf folds every non-arm64 architecture into x64, as the package names do', () => {
    assert.equal(platformKeyOf('linux', 'arm64'), 'linux-arm64');
    assert.equal(platformKeyOf('linux', 'x64'), 'linux-x64');
    assert.equal(platformKeyOf('win32', 'x64'), 'win32-x64');
  });
});

describe('everything else agrees with PLATFORM_TARGETS', () => {
  test('optionalDependencies of the main package are exactly the platform packages', () => {
    const optional = Object.keys(JSON.parse(read('package.json')).optionalDependencies ?? {})
      .filter((n) => n.startsWith('@wadeck-app/orchestrator-cli-')).sort();
    assert.deepEqual(optional, KEYS.map((k) => PLATFORM_TARGETS[k].pkg).sort());
  });

  test('generate-platform-packages.sh generates each package with the os and cpu of its key', () => {
    const script = read('ci', 'scripts', 'generate-platform-packages.sh');
    const generated = [...script.matchAll(/^generate_platform "orchestrator-cli-([\w-]+)"\s+"(\w+)"\s+"(\w+)"/gm)]
      .map((m) => ({ key: m[1], os: m[2], cpu: m[3] }));
    assert.deepEqual(generated.map((g) => g.key).sort(), KEYS);
    for (const g of generated) {
      assert.equal(`${g.os}-${g.cpu}`, g.key, `os and cpu of ${g.key}`);
    }
  });

  test('publish-platform-packages.sh publishes each of them', () => {
    const script = read('ci', 'scripts', 'publish-platform-packages.sh');
    const loop = script.match(/^for p in ([\w\- ]+); do/m);
    assert.ok(loop, 'the platform loop was not found');
    assert.deepEqual(loop[1].trim().split(/\s+/).sort(), KEYS);
  });

  test('copy-binaries.sh copies the launcher and the supervisor into every package, and the tray where there is one', () => {
    const script = read('ci', 'scripts', 'copy-binaries.sh');
    for (const key of KEYS) {
      const dir = `packages/orchestrator-cli-${key}/`;
      const copied = script.split('\n').filter((l) => l.startsWith('cp ') && l.includes(dir));
      const names = (suffix) => copied.some((l) => l.includes(`${dir}orchestrator${suffix}`));
      const exe = key.startsWith('win32') ? '.exe' : '';
      assert.ok(names(exe) , `${key}: launcher`);
      assert.ok(names(`-supervisor${exe}`), `${key}: supervisor`);
      assert.equal(names(`-tray${exe}`), PLATFORM_TARGETS[key].trayDev !== null, `${key}: tray only where it exists`);
    }
  });

  test('copy-binaries.sh reads the file names the builders produce', () => {
    const script = read('ci', 'scripts', 'copy-binaries.sh');
    for (const key of KEYS) {
      const t = PLATFORM_TARGETS[key];
      assert.ok(script.includes(`$LAUNCHER_DIST/${t.launcherDev}`), `${key}: ${t.launcherDev}`);
      assert.ok(script.includes(`$SUPERVISOR_DIST/${t.supervisorDev}`), `${key}: ${t.supervisorDev}`);
      if (t.trayDev !== null) {
        assert.ok(script.includes(`$TRAY_DIST/${t.trayDev}`), `${key}: ${t.trayDev}`);
      }
    }
  });

  test('the supervisor builder produces each supervisor name', () => {
    const script = read('scripts', 'build-supervisor-binary.ts');
    for (const key of KEYS) {
      assert.ok(script.includes(PLATFORM_TARGETS[key].supervisorDev), `${key}: ${PLATFORM_TARGETS[key].supervisorDev}`);
    }
  });

  test('the publish hash covers every binary that is copied', () => {
    const script = read('ci', 'scripts', 'publish-platform-packages.sh');
    for (const key of KEYS) {
      const t = PLATFORM_TARGETS[key];
      assert.ok(script.includes(`$LAUNCHER_DIST/${t.launcherDev}`), `${key}: ${t.launcherDev}`);
      assert.ok(script.includes(`$SUPERVISOR_DIST/${t.supervisorDev}`), `${key}: ${t.supervisorDev}`);
      if (t.trayDev !== null) {
        assert.ok(script.includes(`$TRAY_DIST/${t.trayDev}`), `${key}: ${t.trayDev}`);
      }
    }
  });
});

describe('nativeBinaryProblem (the self-check behind the updater rollback gate)', () => {
  const found = (extra) => ({ platform: 'linux', pkg: '@wadeck-app/orchestrator-cli-linux-x64', launcher: true, tray: false, supervisor: true, ...extra });

  test('Linux without a tray is fine: there is no Linux tray to find', () => {
    assert.equal(nativeBinaryProblem(found({})), null);
  });

  test('Windows and macOS still need their tray', () => {
    for (const platform of ['win32', 'darwin']) {
      assert.match(nativeBinaryProblem(found({ platform, tray: false })), /tray binary not found; expected in @wadeck-app\/orchestrator-cli-linux-x64/);
      assert.equal(nativeBinaryProblem(found({ platform, tray: true })), null);
    }
  });

  test('a missing launcher or supervisor fails on every platform, naming the package', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      assert.match(nativeBinaryProblem(found({ platform, tray: true, launcher: false })), /Go launcher not found/);
      assert.match(nativeBinaryProblem(found({ platform, tray: true, supervisor: false })), /supervisor not found/);
    }
  });
});

describe('trayUnavailableMessage', () => {
  test('on Linux it says there is no systray there and how to reach the dashboard, not "re-install"', () => {
    const m = trayUnavailableMessage('linux', 'x64', '@wadeck-app/orchestrator-cli-linux-x64');
    assert.match(m, /no systray build for linux/);
    assert.match(m, /orch server start/);
    assert.doesNotMatch(m, /Re-install/);
  });

  test('elsewhere a missing binary is a broken install and the message says where to look and what to run', () => {
    const m = trayUnavailableMessage('win32', 'x64', '@wadeck-app/orchestrator-cli-win32-x64');
    assert.match(m, /binary not found. Expected in @wadeck-app\/orchestrator-cli-win32-x64/);
    assert.match(m, /npm install -g @wadeck-app\/orchestrator-cli/);
  });

  test('an unsupported target is named as such', () => {
    assert.match(trayUnavailableMessage('freebsd', 'x64', null), /freebsd-x64 \(unsupported\)/);
  });
});
