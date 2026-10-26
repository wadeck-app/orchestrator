'use strict';

// Node prints DEP0190 ("Passing args to a child process with shell option true") when a library starts a child that way. It went
// unseen for months: the daemon's stderr is the NUL device under the launcher. pidusage 4.0.1 did it on Windows (gwmi.js, powershell
// started through the `shell` option) at the first resource sample; 4.1.0 starts powershell directly. With --throw-deprecation the
// warning becomes a failure, so a dependency that brings it back is caught on the platform where it happens.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('sampling a process with the resource monitor\'s library raises no Node deprecation', () => {
  const run = spawnSync(process.execPath, ['--throw-deprecation', path.join(__dirname, 'helpers', 'sample-self.js')], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(run.status, 0, `exit ${run.status}; stderr:\n${run.stderr}`);
  assert.doesNotMatch(run.stderr, /DeprecationWarning/);
});
