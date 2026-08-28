'use strict';

/**
 * Integration tests for the orchestrator daemon command map.
 * Uses createTestDaemon() from @wadeck/singleton-daemon-kit so tests
 * exercise the real command dispatch without a manual HTTP server.
 */

const { test, describe, before, after } = require('node:test');
const assert  = require('node:assert/strict');
const fs      = require('node:fs');
const path    = require('node:path');
const os      = require('node:os');

const { createTestDaemon }  = require('@wadeck/singleton-daemon-kit');
const { Registry }          = require('../src/registry');
const { State }             = require('../src/state');
const { Scheduler }         = require('../src/scheduler');
const { makeCommands }      = require('../src/commands');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cmd-test-'));
}

async function makeTestDaemon(dir, { withScheduler = false } = {}) {
  const registry  = new Registry(path.join(dir, 'registry.json'));
  const state     = new State(path.join(dir, 'state.json'));
  const scheduler = withScheduler
    ? new Scheduler(registry, state, { configDir: dir })
    : { trigger: async (id) => { throw new Error(`Job not found: "${id}"`); }, start: async () => {}, stop: async () => {} };
  registry.load();

  const handle = await createTestDaemon({ commands: makeCommands(registry, state, scheduler) });
  return { handle, registry, state, client: handle.client };
}

const JOB = {
  id: 'test-job',
  type: 'startup',
  delaySeconds: 0,
  command: 'echo hi',
  enabled: true,
  triggerMode: 'fire-and-forget',
  liveness: null,
};

// ---------------------------------------------------------------------------
// version + health
// ---------------------------------------------------------------------------

describe('daemon basics', () => {
  let handle, client;
  before(async () => {
    const dir = tmpDir();
    ({ handle, client } = await makeTestDaemon(dir));
  });
  after(async () => handle[Symbol.asyncDispose]());

  test('version() returns pid and version', async () => {
    const v = await client.version();
    assert.equal(v.pid, process.pid);
    assert.ok(typeof v.version === 'string');
  });

  test('isRunning() returns true', async () => {
    assert.ok(await client.isRunning());
  });
});

// ---------------------------------------------------------------------------
// Job CRUD via commands
// ---------------------------------------------------------------------------

describe('list-jobs / add-job / remove-job', () => {
  let handle, client;
  before(async () => {
    const dir = tmpDir();
    ({ handle, client } = await makeTestDaemon(dir));
  });
  after(async () => handle[Symbol.asyncDispose]());

  test('list-jobs returns empty array initially', async () => {
    const jobs = await client.send('list-jobs');
    assert.deepEqual(jobs, []);
  });

  test('add-job adds job, returns it', async () => {
    const job = await client.send('add-job', JOB);
    assert.equal(job.id, JOB.id);
  });

  test('list-jobs returns added job', async () => {
    const jobs = await client.send('list-jobs');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, JOB.id);
  });

  test('get-job returns job by id', async () => {
    const job = await client.send('get-job', { id: JOB.id });
    assert.equal(job.id, JOB.id);
  });

  test('get-job returns null for unknown id', async () => {
    const job = await client.send('get-job', { id: 'ghost' });
    assert.equal(job, null);
  });

  test('add-job with invalid data throws', async () => {
    await assert.rejects(
      () => client.send('add-job', { id: '', type: 'cron' }),
    );
  });

  test('edit-job updates label', async () => {
    const job = await client.send('edit-job', { id: JOB.id, updates: { label: 'Updated' } });
    assert.equal(job.label, 'Updated');
  });

  test('enable-job / disable-job toggle enabled', async () => {
    await client.send('disable-job', { id: JOB.id });
    const disabled = await client.send('get-job', { id: JOB.id });
    assert.equal(disabled.enabled, false);

    await client.send('enable-job', { id: JOB.id });
    const enabled = await client.send('get-job', { id: JOB.id });
    assert.equal(enabled.enabled, true);
  });

  test('remove-job removes the job', async () => {
    await client.send('remove-job', { id: JOB.id });
    const jobs = await client.send('list-jobs');
    assert.deepEqual(jobs, []);
  });

  test('remove-job on unknown id throws', async () => {
    await assert.rejects(
      () => client.send('remove-job', { id: 'ghost' }),
    );
  });
});

// ---------------------------------------------------------------------------
// trigger-job
// ---------------------------------------------------------------------------

describe('trigger-job', () => {
  let handle, client, registry;
  before(async () => {
    const dir = tmpDir();
    ({ handle, client, registry } = await makeTestDaemon(dir, { withScheduler: true }));
    registry.add(JOB);
  });
  after(async () => handle[Symbol.asyncDispose]());

  test('trigger-job returns pid for fire-and-forget', async () => {
    const result = await client.send('trigger-job', { id: JOB.id, wait: false });
    assert.ok('pid' in result);
  });

  test('trigger-job unknown id throws', async () => {
    await assert.rejects(
      () => client.send('trigger-job', { id: 'ghost' }),
    );
  });
});

// ---------------------------------------------------------------------------
// list-state
// ---------------------------------------------------------------------------

describe('list-state', () => {
  let handle, client;
  before(async () => {
    const dir = tmpDir();
    ({ handle, client } = await makeTestDaemon(dir));
  });
  after(async () => handle[Symbol.asyncDispose]());

  test('list-state returns empty object initially', async () => {
    const s = await client.send('list-state');
    assert.deepEqual(s, {});
  });
});
