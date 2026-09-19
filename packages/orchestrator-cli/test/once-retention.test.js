'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry, ONCE_RETENTION_DEFAULTS } = require('../src/registry');

/*
 * A spent `once` job used to be deleted from the registry the moment it fired, so the audit could not
 * tell a once job's single run from any other: `job.added` said `type: once`, and then the job was
 * gone with nothing recording that it had been consumed rather than removed by a user.
 *
 * It is now marked `spent` + `spentAt` and kept, bounded by a retention policy so the file cannot grow
 * without limit: 360 days or 50 spent jobs by default, whichever bound is reached first.
 */

const dirs = [];
const DAY = 24 * 60 * 60 * 1000;

after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeRegistry(options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-once-retention-'));
  dirs.push(dir);
  const file = path.join(dir, 'registry.json');
  return { registry: new Registry(file, options), file };
}

function onceJob(id, overrides = {}) {
  return {
    id, type: 'once', command: `echo ${id}`, label: id,
    enabled: true, triggerMode: 'fire-and-forget',
    delayMs: 1000, scheduledAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// markSpent
// ---------------------------------------------------------------------------

describe('markSpent keeps the job instead of deleting it', () => {
  test('the job survives with spent and spentAt set', () => {
    const at = Date.parse('2026-09-19T10:00:00.000Z');
    const { registry } = makeRegistry({ now: () => at });
    registry.add(onceJob('o1'));

    registry.markSpent('o1');

    const job = registry.get('o1');
    assert.notEqual(job, null, 'the job was deleted instead of being marked');
    assert.equal(job.spent, true);
    assert.equal(job.spentAt, new Date(at).toISOString());
  });

  test('it survives a reload -- the mark is on disk, not only in memory', () => {
    const { registry, file } = makeRegistry();
    registry.add(onceJob('o1'));
    registry.markSpent('o1');

    const fresh = new Registry(file);
    fresh.load();
    assert.equal(fresh.get('o1').spent, true);
  });

  test('spentAt records the first firing, so a re-trigger does not rewrite history', () => {
    let now = Date.parse('2026-09-19T10:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now });
    registry.add(onceJob('o1'));
    registry.markSpent('o1');
    const first = registry.get('o1').spentAt;

    now += DAY;
    registry.markSpent('o1');

    assert.equal(registry.get('o1').spentAt, first, 'spentAt moved on the second call');
  });

  test('an unknown id is an error, not a silent no-op', () => {
    const { registry } = makeRegistry();
    assert.throws(() => registry.markSpent('nope'), /Job not found: "nope"/);
  });

  test('only a once job can be spent -- a cron job has no single firing to spend', () => {
    const { registry } = makeRegistry();
    registry.add({
      id: 'c1', type: 'cron', schedule: '*/5 * * * *', command: 'echo tick',
      label: 'c1', enabled: true, triggerMode: 'fire-and-forget',
    });
    assert.throws(() => registry.markSpent('c1'), /not a once job/);
  });
});

// ---------------------------------------------------------------------------
// Retention -- the age bound
// ---------------------------------------------------------------------------

describe('retention by age', () => {
  test('a spent job older than the retention window is dropped on the next mark', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now, onceRetentionDays: 10 });
    registry.add(onceJob('old'));
    registry.markSpent('old');

    now += 11 * DAY;
    registry.add(onceJob('new'));
    registry.markSpent('new');

    assert.equal(registry.get('old'), null, 'a spent job past the retention window was kept');
    assert.notEqual(registry.get('new'), null, 'the fresh spent job was pruned too');
  });

  test('a spent job inside the window is kept', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now, onceRetentionDays: 10 });
    registry.add(onceJob('recent'));
    registry.markSpent('recent');

    now += 9 * DAY;
    registry.add(onceJob('new'));
    registry.markSpent('new');

    assert.notEqual(registry.get('recent'), null, 'a spent job inside the window was dropped');
  });

  test('load() prunes too, so a daemon that was down for a year does not resurrect the backlog', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry, file } = makeRegistry({ now: () => start, onceRetentionDays: 10 });
    registry.add(onceJob('old'));
    registry.markSpent('old');

    const later = new Registry(file, { now: () => start + 30 * DAY, onceRetentionDays: 10 });
    later.load();

    assert.equal(later.get('old'), null, 'load() kept a spent job past the retention window');
    // Persisted, not merely filtered in memory: the next reader must see the same registry.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.jobs.find(j => j.id === 'old'), undefined, 'the prune was not written to disk');
  });
});

// ---------------------------------------------------------------------------
// Retention -- the count bound
// ---------------------------------------------------------------------------

describe('retention by count', () => {
  test('only the newest N spent jobs are kept', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now, onceRetentionMaxJobs: 3 });

    for (let i = 1; i <= 5; i++) {
      registry.add(onceJob(`o${i}`));
      registry.markSpent(`o${i}`);
      now += 1000;
    }

    const kept = registry.list().filter(j => j.spent).map(j => j.id);
    assert.deepEqual(kept.sort(), ['o3', 'o4', 'o5'], `wrong survivors: ${kept.join(', ')}`);
  });

  test('whichever bound is reached first applies -- the count bound can bite inside the window', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now, onceRetentionDays: 3650, onceRetentionMaxJobs: 2 });

    for (let i = 1; i <= 4; i++) {
      registry.add(onceJob(`o${i}`));
      registry.markSpent(`o${i}`);
      now += 1000;
    }

    assert.equal(registry.list().filter(j => j.spent).length, 2);
  });
});

// ---------------------------------------------------------------------------
// What pruning must never touch
// ---------------------------------------------------------------------------

describe('pruning is confined to spent once jobs', () => {
  test('unspent once jobs and jobs of other types are never pruned', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now, onceRetentionDays: 1, onceRetentionMaxJobs: 1 });

    registry.add({
      id: 'c1', type: 'cron', schedule: '*/5 * * * *', command: 'echo tick',
      label: 'c1', enabled: true, triggerMode: 'fire-and-forget',
    });
    registry.add({
      id: 's1', type: 'startup', command: 'echo boot',
      label: 's1', enabled: true, triggerMode: 'fire-and-forget',
    });
    // Scheduled far out, never fired: this one is the future, not the past.
    registry.add(onceJob('pending', { scheduledAt: new Date(now).toISOString(), delayMs: 400 * DAY }));

    now += 400 * DAY;
    registry.add(onceJob('spent-a'));
    registry.markSpent('spent-a');
    now += 1000;
    registry.add(onceJob('spent-b'));
    registry.markSpent('spent-b');

    const ids = registry.list().map(j => j.id).sort();
    assert.deepEqual(ids, ['c1', 'pending', 's1', 'spent-b'], `pruning reached further than spent once jobs: ${ids.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('defaults', () => {
  test('360 days and 50 jobs, as decided', () => {
    assert.equal(ONCE_RETENTION_DEFAULTS.onceRetentionDays, 360);
    assert.equal(ONCE_RETENTION_DEFAULTS.onceRetentionMaxJobs, 50);
  });

  test('a registry built without options uses them', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { registry } = makeRegistry({ now: () => now });
    for (let i = 1; i <= 52; i++) {
      registry.add(onceJob(`o${i}`));
      registry.markSpent(`o${i}`);
      now += 1000;
    }
    assert.equal(registry.list().filter(j => j.spent).length, 50);
  });
});

// ---------------------------------------------------------------------------
// The mark is the daemon's, not the user's
// ---------------------------------------------------------------------------

describe('spent is daemon-owned', () => {
  test('orch edit --unset spent explains itself instead of reporting an unknown field', () => {
    const { unsettableFieldError } = require('../src/types');
    const message = unsettableFieldError('spent');
    assert.notEqual(message, null, '--unset spent was accepted');
    assert.match(message, /daemon/i, `not actionable: ${message}`);
    assert.doesNotMatch(message, /Unknown job field/, 'reported as a typo rather than as daemon-owned');
  });

  test('a spent job still normalizes and validates -- it is a job, not a tombstone', () => {
    const { registry } = makeRegistry();
    registry.add(onceJob('o1'));
    registry.markSpent('o1');
    // An edit on a spent job must not trip validation on the new fields.
    registry.edit('o1', { label: 'renamed' });
    assert.equal(registry.get('o1').label, 'renamed');
    assert.equal(registry.get('o1').spent, true, 'the edit erased the mark');
  });
});
