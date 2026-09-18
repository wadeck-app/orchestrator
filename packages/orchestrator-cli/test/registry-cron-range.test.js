'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cron = require('node-cron');

const { Registry } = require('../src/registry');

/*
 * The registry used to check only the SHAPE of a cron expression - five groups of digits and
 * separators - so `99 99 99 99 99` was accepted and stored.
 *
 * The harm is not cosmetic. The scheduler guards itself with `if (!cron.validate(...)) return`, so
 * the job was written, listed by `orch list`, shown in the dashboard with a schedule, and then
 * simply never scheduled. No error, no warning, nothing to notice. Found by saving exactly that
 * expression through the web form.
 *
 * Validating with node-cron at the boundary makes the two agree: whatever the registry accepts, the
 * scheduler can actually run.
 */

const dirs = [];

function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cron-range-'));
  dirs.push(dir);
  return new Registry(path.join(dir, 'registry.json'));
}

function cronJob(schedule) {
  return { id: 'j', type: 'cron', command: 'node --version', label: 'J', schedule };
}

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('registry rejects a cron expression the scheduler could not run', () => {
  // The exact expression that got through the web form.
  test('rejects out-of-range fields instead of storing a job that never fires', () => {
    assert.throws(() => makeRegistry().add(cronJob('99 99 99 99 99')), /cron/i);
  });

  for (const [schedule, why] of [
    ['0 25 * * *', 'hour 25'],
    ['60 9 * * *', 'minute 60'],
    ['0 9 32 * *', 'day 32'],
    ['0 9 * 13 *', 'month 13'],
    ['0 9 * * 8', 'weekday 8'],
  ]) {
    test(`rejects ${why}`, () => {
      assert.throws(() => makeRegistry().add(cronJob(schedule)), /cron/i);
    });
  }

  test('names the offending expression, so the message is actionable', () => {
    try {
      makeRegistry().add(cronJob('0 25 * * *'));
      assert.fail('expected a rejection');
    } catch (err) {
      assert.match(err.message, /0 25 \* \* \*/);
    }
  });
});

describe('registry still accepts everything real', () => {
  for (const schedule of [
    '0 9 * * *',
    '*/5 * * * *',
    '10 10,19 * * *',
    '0 9 * * 1-5',
    '30 6,12,18 * * 1,3,5',
    '0 0 1 * *',
    '0 9 * * 0',
    '0 9 * * 7',
  ]) {
    test(`accepts ${schedule}`, () => {
      assert.doesNotThrow(() => makeRegistry().add(cronJob(schedule)));
    });
  }
});

/*
 * Pins the dependency this now relies on. If node-cron ever loosened its validation, the registry
 * would quietly go back to accepting schedules that never fire, and every test above would still
 * pass - they assert the registry's behaviour, which would still be "whatever node-cron says".
 */
describe('node-cron validation, which the registry delegates to', () => {
  test('rejects the out-of-range shapes', () => {
    for (const expr of ['99 99 99 99 99', '0 25 * * *', '60 9 * * *', '0 9 32 * *', '0 9 * 13 *', '0 9 * * 8']) {
      assert.equal(cron.validate(expr), false, `${expr} should be invalid`);
    }
  });

  test('accepts the ordinary ones', () => {
    for (const expr of ['0 9 * * *', '*/5 * * * *', '10 10,19 * * *', '0 9 * * 1-5']) {
      assert.equal(cron.validate(expr), true, `${expr} should be valid`);
    }
  });
});
