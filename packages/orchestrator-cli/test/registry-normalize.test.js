'use strict';

// An empty option is not an option. The registry used to write `"cwd": null` and `"liveness": null`
// on every single job, and `orch edit j --cwd ""` stored an empty string that the scheduler then
// handed to spawn as a working directory. So a field with nothing in it is dropped on write, which
// makes "never configured", "cleared with --unset" and "set to empty" one single shape on disk.
//
// Two fields cannot simply vanish: `label` is read raw in a dozen places (job.label.toLowerCase()
// in JobCardGrid crashes on undefined) and `triggerMode` is non-optional in the type orch-ui
// consumes and rendered as-is. Those fall back to their default instead.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Registry } = require('../src/registry');

const tmpDirs = [];

function makeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-norm-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'registry.json');
  return { registry: new Registry(file), file };
}

function onDisk(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0];
}

const CRON = { id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v' };

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('a job is stored without its empty fields', () => {
  test('an unspecified cwd leaves no key behind, not a null', () => {
    const { registry, file } = makeRegistry();

    registry.add(CRON);

    assert.ok(!('cwd' in registry.get('j1')), 'cwd: null is still served from memory');
    assert.ok(!('cwd' in onDisk(file)), 'cwd: null is still on disk');
  });

  test('an unspecified liveness leaves no key behind either', () => {
    const { registry, file } = makeRegistry();

    registry.add(CRON);

    assert.ok(!('liveness' in registry.get('j1')));
    assert.ok(!('liveness' in onDisk(file)));
  });

  test('empty strings, arrays and objects are all dropped', () => {
    const { registry } = makeRegistry();

    registry.add({ ...CRON, cwd: '', tags: [], env: {}, retryDelays: [], retryOnExitCodes: [] });

    const job = registry.get('j1');
    for (const field of ['cwd', 'tags', 'env', 'retryDelays', 'retryOnExitCodes']) {
      assert.ok(!(field in job), `${field} survived as ${JSON.stringify(job[field])}`);
    }
  });

  test('what was actually configured is kept', () => {
    const { registry } = makeRegistry();

    registry.add({ ...CRON, cwd: 'C:/tmp', tags: ['nightly'], timeoutSeconds: 30 });

    const job = registry.get('j1');
    assert.equal(job.cwd, 'C:/tmp');
    assert.deepEqual(job.tags, ['nightly']);
    assert.equal(job.timeoutSeconds, 30);
  });

  // 0 and false are configured values, not emptiness: dropping delaySeconds: 0 or enabled: false
  // would turn "starts immediately" and "disabled" into "unset".
  test('zero and false are not empty', () => {
    const { registry } = makeRegistry();

    registry.add({
      id: 'j2', type: 'startup', command: 'node -v', delaySeconds: 0, enabled: false,
      timeoutSeconds: 0,
    });

    const job = registry.get('j2');
    assert.equal(job.delaySeconds, 0, 'delaySeconds: 0 was mistaken for empty');
    assert.equal(job.enabled, false, 'a disabled job was mistaken for empty');
    assert.equal(job.timeoutSeconds, 0);
  });
});

describe('the two fields that cannot vanish fall back instead', () => {
  test('no label at all becomes the job id', () => {
    const { registry } = makeRegistry();

    registry.add(CRON);

    assert.equal(registry.get('j1').label, 'j1');
  });

  test('an empty label becomes the job id, rather than an empty title in the UI', () => {
    const { registry } = makeRegistry();

    registry.add({ ...CRON, label: '' });

    assert.equal(registry.get('j1').label, 'j1');
  });

  test('triggerMode is always present, defaulted', () => {
    const { registry } = makeRegistry();

    registry.add(CRON);

    assert.equal(registry.get('j1').triggerMode, 'fire-and-forget');
  });
});

describe('an edit to an empty value clears the field', () => {
  test('--cwd "" reaches the same state as --unset cwd, not an empty string', () => {
    const { registry, file } = makeRegistry();
    registry.add({ ...CRON, cwd: 'C:/tmp' });

    registry.edit('j1', { cwd: '' });

    assert.ok(!('cwd' in registry.get('j1')), 'an empty cwd was stored and would reach spawn()');
    assert.ok(!('cwd' in onDisk(file)));
  });

  test('an emptied label falls back to the id instead of disappearing', () => {
    const { registry } = makeRegistry();
    registry.add({ ...CRON, label: 'Nightly' });

    registry.edit('j1', { label: '' });

    assert.equal(registry.get('j1').label, 'j1');
  });

  test('clearing one field does not disturb the others', () => {
    const { registry } = makeRegistry();
    registry.add({ ...CRON, cwd: 'C:/tmp', label: 'Nightly', timeoutSeconds: 30 });

    registry.edit('j1', { cwd: '' });

    const job = registry.get('j1');
    assert.equal(job.label, 'Nightly');
    assert.equal(job.timeoutSeconds, 30);
    assert.equal(job.schedule, '0 9 * * *');
  });
});

// The daemon caches the file at startup and rewrites the whole thing on every change, so a job
// written by an older version is reshaped as soon as anything else is saved -- no migration step,
// and no file where two shapes coexist.
describe('jobs written by an older version are cleaned up on the next write', () => {
  test('a hand-written cwd: null disappears when another job is added', () => {
    const { registry, file } = makeRegistry();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'legacy', type: 'cron', schedule: '0 9 * * *', command: 'node -v', label: 'Legacy',
        enabled: true, triggerMode: 'fire-and-forget', liveness: null, cwd: null,
      }],
    }));

    registry.add({ id: 'j2', type: 'cron', schedule: '0 10 * * *', command: 'node -v' });

    const legacy = JSON.parse(fs.readFileSync(file, 'utf8')).jobs.find((j) => j.id === 'legacy');
    assert.ok(!('cwd' in legacy), 'the legacy null survived the rewrite');
    assert.ok(!('liveness' in legacy));
    assert.equal(legacy.label, 'Legacy', 'the rewrite damaged a field that was set');
  });

  test('enable/disable also leaves a cleaned file behind', () => {
    const { registry, file } = makeRegistry();
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      jobs: [{
        id: 'legacy', type: 'cron', schedule: '0 9 * * *', command: 'node -v', label: 'Legacy',
        enabled: true, triggerMode: 'fire-and-forget', liveness: null, cwd: null,
      }],
    }));

    registry.disable('legacy');

    const legacy = onDisk(file);
    assert.ok(!('cwd' in legacy) && !('liveness' in legacy));
    assert.equal(legacy.enabled, false);
  });
});
