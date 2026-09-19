'use strict';

// Nothing may execute a native binary from inside node_modules.
//
// npm installs the platform package there, and updating the main package means moving that directory
// aside: `fs.rename` first, and on Windows renaming a directory whose descendant is a running image
// fails with EPERM, after which @npmcli/fs falls back to copying file by file -- and copying a running
// .exe is EBUSY. Proven from npm's own debug log: placeDep nests the platform package, reify retires
// the parent, moveFile falls back, copyfile of orchestrator.exe throws.
//
// So the binaries are copied out once per platform-package version and run from there. npm keeps
// writing them into node_modules; nobody holds them, so the rename always succeeds.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');

const { stageBinary, stagedBinaryPath, pruneStagedBinaries } = require('../src/platform-binary');

const tmpDirs = [];

function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stage-'));
  tmpDirs.push(dir);
  return dir;
}

/** A stand-in for the binary npm installed, with recognisable contents. */
function fakeBinary(dir, name = 'orchestrator.exe', body = 'MZ-fake-launcher') {
  const nested = path.join(dir, 'node_modules', '@wadeck-app', 'orchestrator-cli-win32-x64');
  fs.mkdirSync(nested, { recursive: true });
  const file = path.join(nested, name);
  fs.writeFileSync(file, body);
  return file;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* locked or gone */ }
  }
});

describe('a binary is copied out of node_modules before it is run', () => {
  test('the path returned is under the config dir, not under node_modules', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);

    const staged = stageBinary(source, dir, '2026.9.15-254');

    assert.ok(!staged.includes('node_modules'), `still runs from node_modules: ${staged}`);
    assert.ok(staged.startsWith(dir), `staged outside the config dir: ${staged}`);
    assert.equal(path.basename(staged), 'orchestrator.exe', 'the file name must not change');
  });

  test('the copy has the same contents as the original', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir, 'orchestrator.exe', 'MZ-specific-build');

    const staged = stageBinary(source, dir, '2026.9.15-254');

    assert.equal(fs.readFileSync(staged, 'utf8'), 'MZ-specific-build');
  });

  // The stamp is the platform package's own version, which only changes when the binaries change, so
  // a normal update copies nothing and leaves the start-at-login path alone.
  test('the version stamp is part of the path', () => {
    const dir = tmpDir();

    assert.notEqual(
      stagedBinaryPath(dir, '2026.9.15-254', 'orchestrator.exe'),
      stagedBinaryPath(dir, '2026.9.20-999', 'orchestrator.exe'),
    );
  });

  test('staging twice does not copy twice', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);

    const first = stageBinary(source, dir, '2026.9.15-254');
    const mtime = fs.statSync(first).mtimeMs;
    const second = stageBinary(source, dir, '2026.9.15-254');

    assert.equal(second, first);
    assert.equal(fs.statSync(second).mtimeMs, mtime, 'the binary was copied again for nothing');
  });

  // A copy interrupted half-way leaves a short file, and running it would fail in a way that points
  // nowhere near the real cause.
  test('a truncated copy is replaced rather than run', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir, 'orchestrator.exe', 'MZ-full-length-binary');
    const staged = stageBinary(source, dir, '2026.9.15-254');
    fs.writeFileSync(staged, 'MZ-trunc');

    const again = stageBinary(source, dir, '2026.9.15-254');

    assert.equal(fs.readFileSync(again, 'utf8'), 'MZ-full-length-binary');
  });

  test('the executable bit survives the copy', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir, 'orchestrator');
    fs.chmodSync(source, 0o755);

    const staged = stageBinary(source, dir, '2026.9.15-254');

    // Windows reports a fixed mode, so only the POSIX case can assert this.
    if (process.platform !== 'win32') {
      assert.ok((fs.statSync(staged).mode & 0o111) !== 0, 'the copy is not executable');
    }
  });
});

describe('what happens when staging cannot work', () => {
  test('a source that does not exist is named in the error', () => {
    const dir = tmpDir();
    const missing = path.join(dir, 'node_modules', 'nope', 'orchestrator.exe');

    assert.throws(() => stageBinary(missing, dir, '2026.9.15-254'), (err) => {
      assert.match(err.message, /orchestrator\.exe/, `the error does not name the source: ${err.message}`);
      return true;
    });
  });

  // Fails loudly rather than falling back to the node_modules path: a silent fallback would put the
  // EBUSY back without a word, which is the whole failure this exists to remove.
  test('a destination that cannot be created is reported, not worked around', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);
    // `bin` occupied by a file, so mkdir of `bin/<stamp>` cannot succeed.
    fs.writeFileSync(path.join(dir, 'bin'), 'in the way');

    assert.throws(() => stageBinary(source, dir, '2026.9.15-254'), (err) => {
      assert.match(err.message, /bin/, `the error does not name the path: ${err.message}`);
      assert.ok(!/^ENOTDIR$/.test(err.message), 'raw errno only, with no context');
      return true;
    });
  });

  test('the error explains what was being attempted', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);
    fs.writeFileSync(path.join(dir, 'bin'), 'in the way');

    try {
      stageBinary(source, dir, '2026.9.15-254');
      assert.fail('expected a throw');
    } catch (err) {
      assert.match(err.message, /stage|copy/i, `the message does not say what failed: ${err.message}`);
    }
  });
});

describe('what the callers actually get', () => {
  const { findLauncherBinary, launcherToRun, trayToRun } = require('../src/platform-binary');

  // Both branches are real environments: the published install resolves inside node_modules, a dev
  // checkout resolves to launcher-go/dist. Each is asserted rather than skipped.
  test('a binary from node_modules is staged, a dev build is not', () => {
    const dir = tmpDir();
    const resolved = findLauncherBinary();

    const toRun = launcherToRun(dir);

    if (resolved === null) {
      assert.equal(toRun, null, 'invented a path for a platform with no binary');
    } else if (resolved.includes('node_modules')) {
      assert.ok(!toRun.includes('node_modules'),
        `the launcher would still run from node_modules: ${toRun}`);
      assert.ok(toRun.startsWith(dir));
      assert.equal(fs.statSync(toRun).size, fs.statSync(resolved).size);
    } else {
      assert.equal(toRun, resolved, 'a dev build was copied, so it would go stale');
    }
  });

  test('the tray goes through the same rule', () => {
    const dir = tmpDir();
    const toRun = trayToRun(dir);

    if (toRun !== null && toRun.includes('node_modules')) {
      assert.fail(`the tray would still run from node_modules: ${toRun}`);
    }
  });
});

describe('old versions are pruned', () => {
  test('a stamp other than the current one is removed', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);
    stageBinary(source, dir, 'old-1');
    stageBinary(source, dir, 'old-2');
    stageBinary(source, dir, 'current');

    const removed = pruneStagedBinaries(dir, 'current');

    assert.equal(removed, 2);
    assert.ok(fs.existsSync(stagedBinaryPath(dir, 'current', 'orchestrator.exe')),
      'the version in use was deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'bin', 'old-1')));
  });

  test('nothing to prune is not an error', () => {
    const dir = tmpDir();

    assert.equal(pruneStagedBinaries(dir, 'current'), 0);
  });

  // An old launcher may still be running from its copy, and Windows refuses to delete a running
  // image. That is expected at every daemon start, so it must not surface as a failure.
  test('a directory that cannot be deleted is skipped, not thrown', () => {
    const dir = tmpDir();
    const source = fakeBinary(dir);
    stageBinary(source, dir, 'locked');
    stageBinary(source, dir, 'current');
    const held = fs.openSync(stagedBinaryPath(dir, 'locked', 'orchestrator.exe'), 'r');

    try {
      assert.doesNotThrow(() => pruneStagedBinaries(dir, 'current'));
    } finally {
      fs.closeSync(held);
    }
  });
});
