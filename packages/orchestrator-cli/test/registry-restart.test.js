'use strict';

// restartOnExit in the registry: what add and edit accept, what they refuse and what the refusal tells the user to do.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Registry, validateJob } = require('../src/registry');
const { UNSETTABLE_FIELDS, unsettableFieldError } = require('../src/types');

let dir;
let registry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-registry-restart-'));
  registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (extra = {}) => ({ id: 'web', type: 'startup', command: 'node server.js', timeoutSeconds: 0, ...extra });

describe('add', () => {
  test('true is stored as it is', () => {
    registry.add(job({ restartOnExit: true }));
    assert.equal(registry.get('web').restartOnExit, true);
  });

  test('an object is stored as it is', () => {
    const options = { strategy: 'linear', initialDelaySeconds: 2, stepSeconds: 3, maxDelaySeconds: 20, maxRestarts: 5, windowSeconds: 120, stableAfterSeconds: 600 };
    registry.add(job({ restartOnExit: options }));
    assert.deepEqual(registry.get('web').restartOnExit, options);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
    assert.deepEqual(onDisk.jobs[0].restartOnExit, options);
  });

  test('false is accepted: the job is not restarted', () => {
    registry.add(job({ restartOnExit: false }));
    assert.equal(registry.get('web').restartOnExit, false);
  });

  const refused = [
    ['an empty object', {}, /restartOnExit is empty/],
    ['a string', 'always', /restartOnExit must be true or an object/],
    ['an unknown strategy', { strategy: 'quadratic' }, /restartOnExit\.strategy must be one of fixed, linear, exponential/],
    ['a zero delay', { initialDelaySeconds: 0 }, /restartOnExit\.initialDelaySeconds must be a number above 0/],
    ['a negative window', { windowSeconds: -1 }, /restartOnExit\.windowSeconds must be a whole number of at least 1/],
    ['an option the strategy ignores', { strategy: 'fixed', factor: 2 }, /restartOnExit\.factor only applies to the exponential strategy/],
  ];
  for (const [what, value, pattern] of refused) {
    test(`refused: ${what}`, () => {
      assert.throws(() => registry.add(job({ restartOnExit: value })), pattern);
      assert.equal(registry.get('web'), null, 'a refused job must not be stored');
    });
  }

  test('refused with a retry list, and the message names both ways out for THIS job', () => {
    assert.throws(
      () => registry.add(job({ restartOnExit: true, retryOnExitCodes: [75], retryDelays: [5] })),
      (err) => /cannot be used on the same job/.test(err.message)
        && /orch edit web --unset retryOnExitCodes,retryDelays/.test(err.message)
        && /orch edit web --unset restartOnExit/.test(err.message),
    );
  });

  test('refused with only retryDelays, too', () => {
    assert.throws(() => validateJob(job({ restartOnExit: true, retryDelays: [5] })), /cannot be used on the same job/);
  });

  test('restartOnExit: false next to a retry list is fine', () => {
    registry.add(job({ restartOnExit: false, retryOnExitCodes: [75], retryDelays: [5] }));
    assert.deepEqual(registry.get('web').retryOnExitCodes, [75]);
  });

  test('every job type may have it', () => {
    registry.add(job({ id: 'a', type: 'cron', schedule: '0 8 * * *', restartOnExit: true }));
    registry.add(job({ id: 'b', type: 'manual', restartOnExit: true }));
    registry.add(job({ id: 'c', type: 'once', delayMs: 1000, restartOnExit: true }));
    assert.equal(registry.list().length, 3);
  });
});

describe('edit', () => {
  test('sets it', () => {
    registry.add(job());
    registry.edit('web', { restartOnExit: { maxRestarts: 3 } });
    assert.deepEqual(registry.get('web').restartOnExit, { maxRestarts: 3 });
  });

  test('is refused on a job that has a retry list, and nothing is written', () => {
    registry.add(job({ retryOnExitCodes: [75], retryDelays: [5] }));
    assert.throws(() => registry.edit('web', { restartOnExit: true }), /cannot be used on the same job/);
    assert.equal(registry.get('web').restartOnExit, undefined);
  });

  test('a retry list is refused on a job that restarts', () => {
    registry.add(job({ restartOnExit: true }));
    assert.throws(() => registry.edit('web', { retryOnExitCodes: [1], retryDelays: [5] }), /cannot be used on the same job/);
  });

  test('swapping one for the other in one edit works', () => {
    registry.add(job({ retryOnExitCodes: [75], retryDelays: [5] }));
    registry.edit('web', { restartOnExit: true }, ['retryOnExitCodes', 'retryDelays']);
    assert.equal(registry.get('web').restartOnExit, true);
    assert.equal(registry.get('web').retryDelays, undefined);
  });

  test('--unset restartOnExit removes the key', () => {
    registry.add(job({ restartOnExit: true }));
    registry.edit('web', {}, ['restartOnExit']);
    assert.equal('restartOnExit' in registry.get('web'), false);
  });

  test('restartOnExit is among the fields that can be unset', () => {
    assert.equal(UNSETTABLE_FIELDS.restartOnExit, 'delete');
    assert.equal(unsettableFieldError('restartOnExit'), null);
  });
});
