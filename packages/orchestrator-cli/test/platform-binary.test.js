'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');

// Deliberately the COMPILED module, not src/: findDaemonEntry() resolves relative to its own
// directory, so only the dist/ copy sees the layout that ships. Requires `npm run build` first.
const {
  platformPackage,
  findLauncherBinary,
  findTrayBinary,
  findDaemonEntry,
} = require('../dist/platform-binary.js');

// Binary names each platform is allowed to resolve to. A bare arch ternary used to return the
// darwin name on any non-Windows host, so a Linux checkout resolved and tried to exec a Mach-O
// file. These lists keep that class of mix-up from coming back.
const ALLOWED_LAUNCHER = {
  'win32-x64':    ['orchestrator.exe', 'orchestrator_windows_release.exe'],
  'darwin-arm64': ['orchestrator', 'orchestrator_darwin_arm64_release'],
  'darwin-x64':   ['orchestrator', 'orchestrator_darwin_amd64_release'],
};
const ALLOWED_TRAY = {
  'win32-x64':    ['orchestrator-tray.exe'],
  'darwin-arm64': ['orchestrator-tray', 'orchestrator-tray-arm64'],
  'darwin-x64':   ['orchestrator-tray', 'orchestrator-tray-amd64'],
};

const key = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const supported = Object.prototype.hasOwnProperty.call(ALLOWED_LAUNCHER, key);

describe('platformPackage', () => {
  test('names the platform package, or null when unsupported', () => {
    const pkg = platformPackage();
    if (supported) {
      assert.equal(pkg, `@wadeck-app/orchestrator-cli-${key}`);
    } else {
      assert.equal(pkg, null, `${key} is not a published target, expected null`);
    }
  });
});

describe('findLauncherBinary', () => {
  test('resolves to an existing file with a name valid for this platform', () => {
    const p = findLauncherBinary();
    if (!supported) {
      assert.equal(p, null, `${key} has no launcher, expected null rather than another platform's binary`);
      return;
    }
    assert.ok(p, 'no launcher found: run npm run build-launcher');
    assert.ok(fs.existsSync(p), `resolved to a missing file: ${p}`);
    assert.ok(ALLOWED_LAUNCHER[key].includes(path.basename(p)),
      `${path.basename(p)} is not a ${key} launcher name`);
  });
});

describe('findTrayBinary', () => {
  test('resolves to an existing file with a name valid for this platform', () => {
    const p = findTrayBinary();
    if (!supported) {
      assert.equal(p, null, `${key} has no tray binary, expected null`);
      return;
    }
    assert.ok(p, 'no tray binary found: run npm run build-tray');
    assert.ok(fs.existsSync(p), `resolved to a missing file: ${p}`);
    assert.ok(ALLOWED_TRAY[key].includes(path.basename(p)),
      `${path.basename(p)} is not a ${key} tray name`);
  });
});

describe('findDaemonEntry', () => {
  test('resolves to an existing daemon entry', () => {
    const p = findDaemonEntry();
    assert.ok(p, 'no daemon entry found: run npm run build');
    assert.ok(fs.existsSync(p), `resolved to a missing file: ${p}`);
    assert.ok(['orchestrator.cjs', 'index.js'].includes(path.basename(p)), `unexpected entry: ${p}`);
  });

  test('prefers the newest when both the bundle and the tsc output exist', () => {
    const dir = path.dirname(findDaemonEntry());
    const bundle = path.join(dir, 'orchestrator.cjs');
    const tsc    = path.join(dir, 'index.js');
    if (!fs.existsSync(bundle) || !fs.existsSync(tsc)) return; // only one layout present
    const newest = fs.statSync(bundle).mtimeMs >= fs.statSync(tsc).mtimeMs ? bundle : tsc;
    assert.equal(findDaemonEntry(), newest, 'stale entry selected: a build without a re-bundle would run old code');
  });
});
