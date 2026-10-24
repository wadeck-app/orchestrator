'use strict';

// The suite used to leave about 47 000 folders named orch-* in the OS temp dir (every test did mkdtemp(os.tmpdir())
// and most never removed what they made). Two guards, tested here:
//  1. the preload (helpers/isolate-config-dir.js) points TEMP/TMP/TMPDIR at one root folder for the whole run and
//     removes it when the run ends, so whatever a test forgets goes with it;
//  2. scripts/clean-test-temp.cjs (run by `npm test` before the suite, or by hand) removes what an earlier or crashed
//     run left: orch-* folders of the temp dir older than a given age, nothing else.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRELOAD = path.join(__dirname, 'helpers', 'isolate-config-dir.js');
const CLEANER = path.join(__dirname, '..', 'scripts', 'clean-test-temp.cjs');

const made = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cleanup-check-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function envFor(tempDir, extra = {}) {
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir, ...extra };
  delete env.ORCH_TEST_TMP_ROOT;
  return env;
}

function age(target, minutes) {
  const when = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(target, when, when);
}

describe('the test preload keeps the temp files of a run in one root and removes it', () => {
  test('a folder made with os.tmpdir() lands in the run\'s root, and is gone when the run ends', () => {
    const outer = scratch();
    // The probe makes a folder the way the tests do, with no cleanup of its own, and reports where it is.
    const probe = path.join(outer, 'probe.js');
    fs.writeFileSync(probe, [
      "const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');",
      "const made = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-forgotten-'));",
      "fs.writeFileSync(path.join(made, 'f.txt'), 'x');",
      "process.stdout.write(JSON.stringify({ made, root: process.env.ORCH_TEST_TMP_ROOT, tmp: os.tmpdir() }));",
    ].join('\n'));

    const run = spawnSync(process.execPath, ['--require', PRELOAD, probe], { env: envFor(outer), encoding: 'utf8' });
    assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
    const seen = JSON.parse(run.stdout);

    assert.ok(seen.root, 'ORCH_TEST_TMP_ROOT is not set by the preload');
    assert.equal(path.dirname(seen.root), path.resolve(outer), 'the root is not inside the temp dir the run started with');
    assert.equal(path.resolve(seen.tmp), path.resolve(seen.root), 'os.tmpdir() does not point at the root');
    assert.ok(path.resolve(seen.made).startsWith(path.resolve(seen.root)), 'the forgotten folder is outside the root');
    assert.equal(fs.existsSync(seen.made), false, 'the folder a test forgot survived the end of the run');
    assert.equal(fs.existsSync(seen.root), false, 'the root survived the end of the run');
  });

  test('a child process of the run shares the root and does not remove it', () => {
    const outer = scratch();
    const child = path.join(outer, 'child.js');
    fs.writeFileSync(child, "process.stdout.write(process.env.ORCH_TEST_TMP_ROOT + '|' + require('node:os').tmpdir());");
    const parent = path.join(outer, 'parent.js');
    fs.writeFileSync(parent, [
      "const { spawnSync } = require('node:child_process');",
      `const r = spawnSync(process.execPath, ['--require', ${JSON.stringify(PRELOAD)}, ${JSON.stringify(child)}], { encoding: 'utf8' });`,
      "const [root, tmp] = r.stdout.split('|');",
      "process.stdout.write(JSON.stringify({ root, tmp, rootStillThere: require('node:fs').existsSync(root), parentRoot: process.env.ORCH_TEST_TMP_ROOT }));",
    ].join('\n'));

    const run = spawnSync(process.execPath, ['--require', PRELOAD, parent], { env: envFor(outer), encoding: 'utf8' });
    assert.equal(run.status, 0, `probe failed: ${run.stderr}`);
    const seen = JSON.parse(run.stdout);

    assert.equal(seen.root, seen.parentRoot, 'the child made a root of its own instead of sharing the run\'s');
    assert.equal(seen.rootStillThere, true, 'the child removed the root of the run when it exited');
  });
});

describe('scripts/clean-test-temp.cjs', () => {
  function populate(temp) {
    const old = path.join(temp, 'orch-registry-test-AAAAAA');
    const recent = path.join(temp, 'orch-scheduler-test-BBBBBB');
    const foreign = path.join(temp, 'somebody-elses-old-folder');
    for (const dir of [old, recent, foreign]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
    }
    age(old, 120);
    age(foreign, 120);
    return { old, recent, foreign };
  }

  function clean(temp, ...args) {
    return spawnSync(process.execPath, [CLEANER, ...args], { env: envFor(temp), encoding: 'utf8' });
  }

  test('removes the old orch-* folders, keeps the recent ones and everything that is not ours', () => {
    const temp = scratch();
    const { old, recent, foreign } = populate(temp);

    const run = clean(temp, '--older-than-minutes', '30');

    assert.equal(run.status, 0, `cleaner failed: ${run.stderr}`);
    assert.equal(fs.existsSync(old), false, 'an old orch-* folder was kept');
    assert.equal(fs.existsSync(recent), true, 'a recent orch-* folder (a run in progress?) was removed');
    assert.equal(fs.existsSync(foreign), true, 'a folder that is not an orch-* one was removed');
    assert.match(run.stdout, /removed 1\b/, `the summary does not say what it did: ${run.stdout}`);
  });

  test('--dry-run says what it would remove and removes nothing', () => {
    const temp = scratch();
    const { old } = populate(temp);

    const run = clean(temp, '--older-than-minutes', '30', '--dry-run');

    assert.equal(run.status, 0, `cleaner failed: ${run.stderr}`);
    assert.equal(fs.existsSync(old), true, 'a dry run removed something');
    assert.match(run.stdout, /would remove 1\b/);
  });

  test('a bad age is refused with the accepted values, not read as zero', () => {
    const temp = scratch();
    const run = clean(temp, '--older-than-minutes', 'soon');
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /older-than-minutes/);
    assert.match(run.stderr, /whole number/);
  });
});
