'use strict';

// liveness.timeoutSeconds bounds the `command` strategy (default 30 s). It is validated where every write passes
// (validateJob), so the CLI, the dashboard and a hand-edited registry all get the same refusal, naming the key and the flag.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { validateJob } = require('../src/registry');
const { buildLiveness, livenessTimeoutFlag, EXTRA_ADD_FLAGS, EXTRA_EDIT_FLAGS } = require('../src/cli');

function job(liveness) {
  return { id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v', liveness };
}

describe('validateJob: liveness.timeoutSeconds', () => {
  test('a whole number of seconds with the command strategy is accepted', () => {
    assert.doesNotThrow(() => validateJob(job({ strategy: 'command', command: 'check', timeoutSeconds: 10 })));
    assert.doesNotThrow(() => validateJob(job({ strategy: 'command', command: 'check', timeoutSeconds: 1 })));
    assert.doesNotThrow(() => validateJob(job({ strategy: 'command', command: 'check', timeoutSeconds: 3600 })));
  });

  test('absent is accepted (the default applies)', () => {
    assert.doesNotThrow(() => validateJob(job({ strategy: 'command', command: 'check' })));
  });

  for (const bad of [0, -1, 1.5, '5', 3601, Number.NaN]) {
    test(`${JSON.stringify(bad)} is refused with the key, the range and the flag`, () => {
      assert.throws(
        () => validateJob(job({ strategy: 'command', command: 'check', timeoutSeconds: bad })),
        (e) => /liveness\.timeoutSeconds/.test(e.message) && /1.*3600/.test(e.message) && /--liveness-timeout/.test(e.message),
      );
    });
  }

  test('with another strategy it is refused instead of being ignored', () => {
    for (const liveness of [
      { strategy: 'portFile', portFile: '~/x.json', timeoutSeconds: 10 },
      { strategy: 'pidFile', timeoutSeconds: 10 },
    ]) {
      assert.throws(
        () => validateJob(job(liveness)),
        (e) => /liveness\.timeoutSeconds/.test(e.message) && /command/.test(e.message),
      );
    }
  });
});

describe('--liveness-timeout', () => {
  test('is accepted by add and edit', () => {
    assert.ok(EXTRA_ADD_FLAGS.includes('--liveness-timeout'));
    assert.ok(EXTRA_EDIT_FLAGS.includes('--liveness-timeout'));
  });

  test('buildLiveness puts it in the command strategy as a number', () => {
    assert.deepEqual(
      buildLiveness(['--liveness-strategy', 'command', '--liveness-command', 'check', '--liveness-timeout', '45']),
      { strategy: 'command', command: 'check', timeoutSeconds: 45 },
    );
  });

  test('without the flag nothing is written, so the default applies', () => {
    assert.deepEqual(
      buildLiveness(['--liveness-strategy', 'command', '--liveness-command', 'check']),
      { strategy: 'command', command: 'check' },
    );
  });

  test('a value that is not a whole number says what to type', () => {
    assert.throws(
      () => livenessTimeoutFlag(['--liveness-timeout', 'abc']),
      /--liveness-timeout expects a whole number of seconds, but got "abc"/,
    );
    assert.throws(() => livenessTimeoutFlag(['--liveness-timeout']), /--liveness-timeout needs a value/);
  });
});
