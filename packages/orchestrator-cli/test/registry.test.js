'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry } = require('../src/registry');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-registry-test-'));
}

function makeRegistry(dir) {
  return new Registry(path.join(dir, 'registry.json'));
}

const JOB_CRON = {
  id: 'assurance-daily',
  type: 'cron',
  label: 'Assurance scraper',
  schedule: '0 8 * * *',
  command: 'npm run scrape',
  cwd: '/tmp',
  enabled: true,
  triggerMode: 'fire-and-forget',
  missedFiring: 'catch-up',
  liveness: null,
};

const JOB_STARTUP = {
  id: 'wdrive-start',
  type: 'startup',
  label: 'wdrive',
  delaySeconds: 30,
  command: '/usr/local/bin/wdrive',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: { strategy: 'portFile', portFile: '~/.wdrive/config.port' },
};

// ---------------------------------------------------------------------------
// First-run: no file
// ---------------------------------------------------------------------------

describe('first-run (no registry file)', () => {
  test('load() returns empty jobs list when file absent', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const data = reg.load();
    assert.equal(data.version, 1);
    assert.deepEqual(data.jobs, []);
  });

  test('load() creates registry.json on first access', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.load();
    assert.ok(fs.existsSync(path.join(dir, 'registry.json')));
  });
});

// ---------------------------------------------------------------------------
// Version mismatch
// ---------------------------------------------------------------------------

describe('version mismatch', () => {
  test('load() throws when version > 1', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ version: 99, jobs: [] }));
    const reg = makeRegistry(dir);
    assert.throws(
      () => reg.load(),
      (err) => {
        assert.ok(err.message.includes('version 99'));
        assert.ok(err.message.includes('not supported'));
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('add()', () => {
  test('adds a cron job and persists atomically', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    const data = reg.load();
    assert.equal(data.jobs.length, 1);
    assert.equal(data.jobs[0].id, 'assurance-daily');
  });

  test('throws on duplicate id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    assert.throws(() => reg.add(JOB_CRON), /duplicate/i);
  });

  test('throws on missing id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(() => reg.add({ ...JOB_CRON, id: '' }), /id/i);
  });

  test('throws on invalid cron expression', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(
      () => reg.add({ ...JOB_CRON, schedule: 'not-a-cron' }),
      /schedule/i
    );
  });

  test('throws if cron job missing schedule', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const { schedule: _, ...noSchedule } = JOB_CRON;
    assert.throws(() => reg.add(noSchedule), /schedule/i);
  });

  test('throws if startup job has negative delaySeconds', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(
      () => reg.add({ ...JOB_STARTUP, delaySeconds: -1 }),
      /delay/i
    );
  });

  test('adds startup job with portFile liveness', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_STARTUP);
    const data = reg.load();
    assert.equal(data.jobs[0].liveness.strategy, 'portFile');
  });

  test('throws on unknown liveness strategy', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(
      () => reg.add({ ...JOB_CRON, liveness: { strategy: 'magic' } }),
      /liveness/i
    );
  });
});

describe('remove()', () => {
  test('removes existing job', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    reg.remove('assurance-daily');
    assert.equal(reg.load().jobs.length, 0);
  });

  test('throws on unknown id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(() => reg.remove('nonexistent'), /not found/i);
  });
});

describe('enable() / disable()', () => {
  test('disable sets enabled=false', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    reg.disable('assurance-daily');
    assert.equal(reg.load().jobs[0].enabled, false);
  });

  test('enable sets enabled=true', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add({ ...JOB_CRON, enabled: false });
    reg.enable('assurance-daily');
    assert.equal(reg.load().jobs[0].enabled, true);
  });
});

describe('edit()', () => {
  test('updates only specified fields', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    reg.edit('assurance-daily', { label: 'New label', schedule: '0 9 * * *' });
    const job = reg.load().jobs[0];
    assert.equal(job.label, 'New label');
    assert.equal(job.schedule, '0 9 * * *');
    assert.equal(job.command, JOB_CRON.command); // unchanged
  });

  test('throws on invalid schedule in edit', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    assert.throws(
      () => reg.edit('assurance-daily', { schedule: 'bad-cron' }),
      /schedule/i
    );
  });

  test('throws on unknown id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.throws(() => reg.edit('ghost', { label: 'x' }), /not found/i);
  });
});

describe('get()', () => {
  test('returns job by id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    const job = reg.get('assurance-daily');
    assert.equal(job.id, 'assurance-daily');
  });

  test('returns null for unknown id', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    assert.equal(reg.get('ghost'), null);
  });
});

describe('list()', () => {
  test('returns all jobs', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    reg.add(JOB_STARTUP);
    assert.equal(reg.list().length, 2);
  });
});

// ---------------------------------------------------------------------------
// Atomic write: file not corrupted if process interrupted mid-write
// ---------------------------------------------------------------------------

describe('atomic write', () => {
  test('registry.json.tmp is cleaned up after successful write', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    reg.add(JOB_CRON);
    assert.ok(!fs.existsSync(path.join(dir, 'registry.json.tmp')));
  });
});

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('defaults', () => {
  test('enabled defaults to true', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const { enabled: _, ...noEnabled } = JOB_CRON;
    reg.add(noEnabled);
    assert.equal(reg.load().jobs[0].enabled, true);
  });

  test('triggerMode defaults to fire-and-forget', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const { triggerMode: _, ...noMode } = JOB_CRON;
    reg.add(noMode);
    assert.equal(reg.load().jobs[0].triggerMode, 'fire-and-forget');
  });

  test('missedFiring defaults to skip for cron jobs', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const { missedFiring: _, ...noMissed } = JOB_CRON;
    reg.add(noMissed);
    assert.equal(reg.load().jobs[0].missedFiring, 'skip');
  });

  test('delaySeconds defaults to 0 for startup jobs', () => {
    const dir = tmpDir();
    const reg = makeRegistry(dir);
    const { delaySeconds: _, ...noDelay } = JOB_STARTUP;
    reg.add(noDelay);
    assert.equal(reg.load().jobs[0].delaySeconds, 0);
  });
});
