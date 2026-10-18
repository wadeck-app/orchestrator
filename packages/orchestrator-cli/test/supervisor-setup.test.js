'use strict';

// Whether the daemon runs jobs under a supervisor is decided once, at start, from config.yml and from whether
// the supervisor executable can be found. Asking for it and not getting it must be said in the daemon log:
// jobs then run unsupervised, and the reader has to be able to tell why a restart still stops them.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { supervisorFor } = require('../src/supervised-run');

function setup(overrides = {}) {
  const lines = [];
  const launcher = supervisorFor({
    enabled: true,
    configDir: '/tmp/orch',
    locate: () => '/tmp/orch/bin/1/orchestrator-supervisor',
    log: (line) => lines.push(line),
    ...overrides,
  });
  return { launcher, lines };
}

describe('supervisorFor', () => {
  test('does nothing, and says nothing, when supervisedJobs is off', () => {
    const { launcher, lines } = setup({ enabled: false, locate: () => { throw new Error('must not be looked for'); } });

    assert.equal(launcher, undefined);
    assert.deepEqual(lines, []);
  });

  test('gives a launcher when it is on and the executable is there, and says so once', () => {
    const { launcher, lines } = setup();

    assert.equal(typeof launcher, 'function');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /supervisedJobs.*on/);
    assert.match(lines[0], /orchestrator-supervisor/);
  });

  test('warns, naming the platform and the fix, when it is on but no executable exists for this platform', () => {
    const { launcher, lines } = setup({ locate: () => null });

    assert.equal(launcher, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /supervisedJobs: true/);
    assert.match(lines[0], new RegExp(process.platform));
    assert.match(lines[0], /unsupervised|will not survive/);
  });

  test('warns with the cause when the executable cannot be staged', () => {
    const { launcher, lines } = setup({ locate: () => { throw new Error('Cannot stage the native binary to C:\\x (EPERM)'); } });

    assert.equal(launcher, undefined);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /EPERM/);
    assert.match(lines[0], /unsupervised|will not survive/);
  });
});
