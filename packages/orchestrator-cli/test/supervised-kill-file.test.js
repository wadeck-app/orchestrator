'use strict';

// The `kill` file of a supervised run is how the daemon tells the supervisor to end the job and why ("manual",
// "timeout", "resource-limit"). The supervisor (supervisor-go/run.go) polls for the file and reads its content in the
// same step: a file that exists but is still empty is read as "unspecified", and the run is recorded as killed for
// no stated reason (seen: supervised-run.test.js expected 'manual', got 'unspecified', once in a loaded full run).
//
// fs.writeFileSync creates (and truncates) the file first and writes its content afterwards, so there is a window in
// which the file exists empty. This test opens that window on purpose, deterministically: while the daemon is
// writing, it looks at the run folder the way the supervisor does, at the instant the file has been created and
// nothing has been written to it yet. No supervisor, no clock, no sleep.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { SupervisedChild } = require('../src/supervised-run');

const dirs = [];
const restores = [];
afterEach(() => {
  while (restores.length > 0) {
    restores.pop()();
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop(), { recursive: true, force: true });
  }
});

function runDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-kill-file-'));
  dirs.push(dir);
  return dir;
}

/**
 * Makes every fs.writeFileSync of a path in `dir` stop between "the file exists" and "the content is written", and
 * calls `look` there. Restored after the test. This is what writeFileSync does internally (open with truncation, then
 * write), with the pause made visible.
 */
function lookWhileWriting(dir, look) {
  const original = fs.writeFileSync;
  fs.writeFileSync = function patched(file, data, ...rest) {
    if (typeof file !== 'string' || path.dirname(file) !== dir) {
      return original.call(this, file, data, ...rest);
    }
    const fd = fs.openSync(file, 'w');
    try {
      look(file);
      fs.writeSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    return undefined;
  };
  restores.push(() => { fs.writeFileSync = original; });
}

/** What the supervisor sees of the kill file: whether it is there and what it reads in it. */
function supervisorView(dir) {
  const file = path.join(dir, 'kill');
  if (!fs.existsSync(file)) {
    return { exists: false };
  }
  return { exists: true, content: fs.readFileSync(file, 'utf8') };
}

test('the kill file is never visible without its reason, so the supervisor cannot record "unspecified"', () => {
  const dir = runDir();
  const seen = [];
  lookWhileWriting(dir, () => seen.push(supervisorView(dir)));

  new SupervisedChild(dir, undefined).requestKill('manual');

  assert.ok(seen.length > 0, 'the test did not get to look while the daemon was writing: it proves nothing');
  const empty = seen.filter((view) => view.exists && view.content.trim() === '');
  assert.deepEqual(empty, [], 'the kill file existed with no reason in it: the supervisor would have read "unspecified"');
  assert.equal(fs.readFileSync(path.join(dir, 'kill'), 'utf8'), 'manual');
});

test('nothing is left in the run folder next to the kill file', () => {
  const dir = runDir();

  new SupervisedChild(dir, undefined).requestKill('timeout');

  assert.deepEqual(fs.readdirSync(dir), ['kill']);
});

test('asking twice leaves one complete reason', () => {
  const dir = runDir();
  const seen = [];
  lookWhileWriting(dir, () => seen.push(supervisorView(dir)));
  const child = new SupervisedChild(dir, undefined);

  child.requestKill('resource-limit');
  child.requestKill('manual');

  assert.deepEqual(seen.filter((view) => view.exists && view.content.trim() === ''), []);
  assert.match(fs.readFileSync(path.join(dir, 'kill'), 'utf8'), /^(resource-limit|manual)$/);
  assert.equal(child.killed, true);
});

test('a run folder that is gone is not an error: the run is already over', () => {
  const dir = path.join(runDir(), 'gone');

  assert.doesNotThrow(() => new SupervisedChild(dir, undefined).requestKill('manual'));
});
