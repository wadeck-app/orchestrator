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

  // Every layout is asserted rather than skipped. The previous version returned early when only
  // one entry was present, which is the layout CI's build-and-test actually has -- so the whole
  // test was a no-op exactly where it ran.
  test('the bundle wins over the tsc output whatever the mtimes say', () => {
    const dir = path.dirname(findDaemonEntry());
    const bundle = path.join(dir, 'orchestrator.cjs');
    const tsc    = path.join(dir, 'index.js');
    const hasBundle = fs.existsSync(bundle);
    const hasTsc    = fs.existsSync(tsc);
    assert.ok(hasBundle || hasTsc, 'neither entry exists: run npm run build');

    if (!hasBundle) {
      assert.equal(findDaemonEntry(), tsc, 'tsc-only layout must resolve to the tsc output');
      return;
    }
    if (!hasTsc) {
      assert.equal(findDaemonEntry(), bundle, 'bundle-only layout must resolve to the bundle');
      return;
    }
    // Both present: the selection must not move when the tsc output is made the newer file.
    const original = fs.statSync(tsc);
    try {
      const future = new Date(fs.statSync(bundle).mtimeMs + 60_000);
      fs.utimesSync(tsc, future, future);
      assert.equal(findDaemonEntry(), bundle,
        'a fresher tsc output changed the daemon entry: which code runs must not depend on build order');
    } finally {
      fs.utimesSync(tsc, original.atime, original.mtime);
    }
  });

  test('warns on stderr when the bundle is stale instead of switching silently', () => {
    const dir = path.dirname(findDaemonEntry());
    const bundle = path.join(dir, 'orchestrator.cjs');
    const tsc    = path.join(dir, 'index.js');
    if (!fs.existsSync(bundle) || !fs.existsSync(tsc)) {
      // Not a skip: with one entry there is no staleness to report, and the assertion above
      // already pinned the resolved path for that layout.
      assert.equal(typeof findDaemonEntry(), 'string');
      return;
    }
    const original = fs.statSync(tsc);
    const written = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      const future = new Date(fs.statSync(bundle).mtimeMs + 60_000);
      fs.utimesSync(tsc, future, future);
      findDaemonEntry();
    } finally {
      process.stderr.write = realWrite;
      fs.utimesSync(tsc, original.atime, original.mtime);
    }
    const msg = written.join('');
    assert.match(msg, /bundle is stale/, `expected a staleness warning, got: ${msg || '(nothing)'}`);
    assert.match(msg, /npm run bundle/, 'the warning must name the command that fixes it');
  });
});
