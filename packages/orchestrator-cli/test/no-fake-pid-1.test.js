'use strict';

// A scheduler test whose fake child claims pid 1 and does not replace the process sampler measures pid 1
// FOR REAL: on macOS that is launchd, whose tree is every process on the machine, one `ps` each. That
// made a fake-clock test take 12 to 56 seconds on the macOS CI runner (62 ms on Linux) and filled the
// per-user process table until spawn failed with EAGAIN in whichever test file was starting next.
//
// A fake child needs a fake measurement: pass `sampleUsage`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FAKE_PID_1 = /\.pid\s*=\s*1\s*;|\bpid:\s*1\s*[,}]/;

test('no test lets a fake child with pid 1 be measured for real', () => {
  const dir = __dirname;
  const offenders = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.test.js') && name !== path.basename(__filename))
    .filter((name) => {
      const source = fs.readFileSync(path.join(dir, name), 'utf8');
      return new RegExp('new Scheduler\\(').test(source) && FAKE_PID_1.test(source) && !source.includes('sampleUsage');
    });

  assert.deepEqual(offenders, [], `these build a Scheduler with a pid-1 fake child and no sampleUsage: ${offenders.join(', ')}`);
});
