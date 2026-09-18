'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { Registry } = require('../src/registry');

/*
 * A `once` job fires at scheduledAt + delayMs. Only the CLI ever set scheduledAt - `orch add once`
 * stamps it - so a once job created through the web API arrived with delayMs and nothing to measure
 * it from.
 *
 * The scheduler then computed `now - new Date(undefined).getTime()`, which is NaN, so `remaining`
 * was NaN, `remaining <= 0` was false, and setTimeout(fn, NaN) fires on the next tick. The job ran
 * at the next daemon start and its delay was silently ignored.
 *
 * Defaulted at the registry rather than in each caller: the CLI, the HTTP API and any future one all
 * go through here, and a required field that every caller must remember is a field someone forgets.
 */

const dirs = [];

function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-'));
  dirs.push(dir);
  return new Registry(path.join(dir, 'registry.json'));
}

function onceJob(extra = {}) {
  return { id: 'o', type: 'once', command: 'node --version', label: 'O', delayMs: 60_000, ...extra };
}

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('a once job always has something to measure its delay from', () => {
  test('stamps scheduledAt when the caller did not', () => {
    const registry = makeRegistry();
    const before = Date.now();

    registry.add(onceJob());

    const stored = registry.list().find(j => j.id === 'o');
    assert.ok(stored.scheduledAt, 'scheduledAt must be set');
    const at = new Date(stored.scheduledAt).getTime();
    assert.ok(Number.isFinite(at), 'scheduledAt must be a real date');
    assert.ok(at >= before - 1000 && at <= Date.now() + 1000, 'scheduledAt should be about now');
  });

  // The CLI stamps its own, and a restored backup carries one. Overwriting would move the job's
  // moment every time the registry was rewritten.
  test('keeps a scheduledAt the caller supplied', () => {
    const registry = makeRegistry();
    const explicit = '2026-01-01T00:00:00.000Z';

    registry.add(onceJob({ scheduledAt: explicit }));

    assert.equal(registry.list().find(j => j.id === 'o').scheduledAt, explicit);
  });

  test('leaves cron and startup jobs alone', () => {
    const registry = makeRegistry();

    registry.add({ id: 'c', type: 'cron', command: 'x', label: 'C', schedule: '0 9 * * *' });
    registry.add({ id: 's', type: 'startup', command: 'x', label: 'S', delaySeconds: 0 });

    assert.equal(registry.list().find(j => j.id === 'c').scheduledAt, undefined);
    assert.equal(registry.list().find(j => j.id === 's').scheduledAt, undefined);
  });

  // What the scheduler actually computes. NaN was the whole bug: it is neither <= 0 nor a usable
  // delay, so the job fell through to setTimeout(fn, NaN) and fired at once.
  test('the remaining delay is a finite number, not NaN', () => {
    const registry = makeRegistry();
    registry.add(onceJob({ delayMs: 60_000 }));

    const stored = registry.list().find(j => j.id === 'o');
    const remaining = stored.delayMs - (Date.now() - new Date(stored.scheduledAt).getTime());

    assert.ok(Number.isFinite(remaining), `remaining must be finite, got ${remaining}`);
    assert.ok(remaining > 0, 'a 60s delay just set should still be in the future');
  });
});
