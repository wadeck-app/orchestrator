'use strict';

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { removeJobData, dropStaleJobData } = require('../src/job-data-cleanup');
const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

/*
 * Removing a job used to leave everything it had produced behind, and a job added later under the same
 * id inherited it: its telemetry, its resource history, its run folders. These tests hold the deletion
 * of the DERIVED data to account, and the keeping of the logs, which are the record of what the job did.
 */

const tmpDirs = [];

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cleanup-'));
  tmpDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function put(dir, rel, content = 'x') {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function exists(dir, rel) {
  return fs.existsSync(path.join(dir, ...rel.split('/')));
}

/** A run folder as the supervisor leaves it. */
function putRun(dir, jobId, name, { state, done }) {
  put(dir, `runs/${jobId}/${name}/spec.json`, '{}');
  put(dir, `runs/${jobId}/${name}/status.json`, JSON.stringify({ state, supervisorPid: 1 }));
  if (done) {
    put(dir, `runs/${jobId}/${name}/done`, '');
  }
}

function populate(dir, id) {
  put(dir, `telemetry/${id}.ndjson`);
  put(dir, `telemetry/${id}.1.ndjson`);
  put(dir, `resource-history/${id}.ndjson`);
  put(dir, `resource-history/${id}.ndjson.tmp`);
  put(dir, `logs/jobs/${id}/${id}-2026-01-01T00-00-00.log`, 'a log');
  putRun(dir, id, '2026-01-01T00-00-00.000Z', { state: 'exited', done: true });
  putRun(dir, id, '2026-01-02T00-00-00.000Z', { state: 'exited', done: false });
  fs.mkdirSync(path.join(dir, 'tmp', id), { recursive: true });
}

describe('removeJobData', () => {
  test('deletes telemetry, resource history, finished runs and the empty tmp cwd; keeps the logs', () => {
    const dir = makeDir();
    populate(dir, 'job-a');
    put(dir, 'telemetry/job-b.ndjson');

    const result = removeJobData(dir, 'job-a');

    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), false);
    assert.equal(exists(dir, 'telemetry/job-a.1.ndjson'), false);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson'), false);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson.tmp'), false);
    assert.equal(exists(dir, 'runs/job-a'), false, 'the emptied runs/<id> folder goes too');
    assert.equal(exists(dir, 'tmp/job-a'), false);
    assert.equal(exists(dir, 'logs/jobs/job-a/job-a-2026-01-01T00-00-00.log'), true, 'logs are kept');
    assert.equal(exists(dir, 'telemetry/job-b.ndjson'), true, 'another job is untouched');
    assert.deepEqual(result.cleaned, { telemetry: 2, resourceHistory: 2, runs: 2 });
    assert.deepEqual(result.leftovers, []);
  });

  test('a tmp cwd that holds files is kept', () => {
    const dir = makeDir();
    put(dir, 'tmp/job-a/output.txt');

    removeJobData(dir, 'job-a');

    assert.equal(exists(dir, 'tmp/job-a/output.txt'), true);
  });

  test('a run folder whose supervisor is still running is never touched', () => {
    const dir = makeDir();
    putRun(dir, 'job-a', 'live', { state: 'running', done: false });
    putRun(dir, 'job-a', 'old', { state: 'exited', done: true });

    const result = removeJobData(dir, 'job-a');

    assert.equal(exists(dir, 'runs/job-a/live/status.json'), true);
    assert.equal(exists(dir, 'runs/job-a/live/spec.json'), true);
    assert.equal(exists(dir, 'runs/job-a/old'), false);
    assert.equal(result.cleaned.runs, 1);
  });

  test('a run folder that cannot be read is kept and reported', () => {
    const dir = makeDir();
    put(dir, 'runs/job-a/odd/status.json', 'not json');

    const result = removeJobData(dir, 'job-a');

    assert.equal(exists(dir, 'runs/job-a/odd/status.json'), true);
    assert.equal(result.leftovers.length, 1);
    assert.match(result.leftovers[0].reason, /status\.json/);
  });

  test('a job with a run in progress keeps the files that run writes, and says so', () => {
    const dir = makeDir();
    populate(dir, 'job-a');

    const result = removeJobData(dir, 'job-a', { running: true });

    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), true);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson'), true);
    assert.equal(exists(dir, 'runs/job-a'), false, 'finished runs still go');
    assert.ok(result.leftovers.length > 0);
    assert.match(result.leftovers[0].reason, /still running/);
  });

  test('a locked file is reported, not thrown, and the rest is deleted', () => {
    const dir = makeDir();
    populate(dir, 'job-a');
    const locked = path.join(dir, 'telemetry', 'job-a.ndjson');
    const lockedFs = {
      ...fs,
      rmSync: (p, o) => {
        if (p === locked) {
          const err = new Error(`EBUSY: resource busy or locked, unlink '${p}'`);
          err.code = 'EBUSY';
          throw err;
        }
        return fs.rmSync(p, o);
      },
    };

    const result = removeJobData(dir, 'job-a', { fs: lockedFs });

    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), true);
    assert.equal(exists(dir, 'telemetry/job-a.1.ndjson'), false);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson'), false);
    assert.equal(result.leftovers.length, 1);
    assert.equal(result.leftovers[0].path, locked);
    assert.match(result.leftovers[0].reason, /EBUSY/);
    assert.equal(result.cleaned.telemetry, 1);
  });

  describe('a hostile id never deletes outside the config dir', () => {
    for (const hostile of ['..', '../outside', 'a/b', 'a\\b', '..\\outside', '', '.', 'a b']) {
      test(`id ${JSON.stringify(hostile)}`, () => {
        const root = makeDir();
        const dir = path.join(root, 'config');
        fs.mkdirSync(dir);
        const sentinel = put(root, 'outside.ndjson');
        put(root, 'outside/keep.txt');
        put(dir, 'telemetry/x.ndjson');
        put(dir, 'runs/x/r/done', '');

        const result = removeJobData(dir, hostile);
        const dropped = dropStaleJobData(dir, hostile);

        assert.equal(fs.existsSync(sentinel), true);
        assert.equal(exists(root, 'outside/keep.txt'), true);
        assert.equal(exists(dir, 'telemetry/x.ndjson'), true);
        assert.equal(exists(dir, 'runs/x/r/done'), true);
        assert.deepEqual(result.cleaned, { telemetry: 0, resourceHistory: 0, runs: 0 });
        assert.equal(result.leftovers.length, 1);
        assert.match(result.leftovers[0].reason, /not a valid job id/);
        assert.equal(dropped.leftovers.length, 1);
      });
    }
  });
});

describe('dropStaleJobData', () => {
  test('drops only telemetry and resource history', () => {
    const dir = makeDir();
    populate(dir, 'job-a');

    const result = dropStaleJobData(dir, 'job-a');

    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), false);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson'), false);
    assert.equal(exists(dir, 'logs/jobs/job-a/job-a-2026-01-01T00-00-00.log'), true);
    assert.equal(exists(dir, 'runs/job-a/2026-01-02T00-00-00.000Z/status.json'), true);
    assert.deepEqual(result.cleaned, { telemetry: 2, resourceHistory: 2, runs: 0 });
  });
});

describe('remove-job and add-job through the commands', () => {
  function env({ running = 0 } = {}) {
    const dir = makeDir();
    const entries = [];
    const lines = [];
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    const scheduler = {
      killJob: async () => ({ killed: false }), skipNextFiring: () => {},
      scheduleJob: () => {}, unscheduleJob: () => {},
      runningCount: () => running,
    };
    const audit = { log: (event, payload) => entries.push({ event, payload }) };
    const commands = makeCommands(registry, state, scheduler, dir, undefined, audit, undefined, undefined, undefined, (l) => lines.push(l));
    return { dir, commands, entries, lines, state };
  }

  const JOB = { id: 'job-a', type: 'manual', command: 'node -v', label: 'A' };

  test('job.deleted carries cleaned counts and the reply has no leftovers when all went', () => {
    const { dir, commands, entries } = env();
    commands['add-job'](JOB);
    populate(dir, 'job-a');

    const reply = commands['remove-job']({ id: 'job-a' });

    const deleted = entries.find(e => e.event === 'job.deleted');
    assert.deepEqual(deleted.payload.cleaned, { telemetry: 2, resourceHistory: 2, runs: 2 });
    assert.equal(deleted.payload.type, 'manual');
    assert.equal(reply === undefined || reply.leftovers === undefined, true);
    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), false);
    assert.equal(exists(dir, 'logs/jobs/job-a/job-a-2026-01-01T00-00-00.log'), true);
  });

  test('a job with a running instance: leftovers in the reply and one line in the daemon log', () => {
    const { dir, commands, lines } = env({ running: 1 });
    commands['add-job'](JOB);
    populate(dir, 'job-a');

    const reply = commands['remove-job']({ id: 'job-a' });

    assert.ok(Array.isArray(reply.leftovers) && reply.leftovers.length > 0);
    assert.ok(lines.some(l => l.includes('job-a') && l.includes('telemetry') && /still running/.test(l)), lines.join('\n'));
    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), true);
  });

  test('removal clears the job history in state.json', () => {
    const { commands, state } = env();
    commands['add-job'](JOB);
    state.record('job-a', { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, pid: 1 });
    assert.ok(state.getAll()['job-a'], 'precondition: the history exists');

    commands['remove-job']({ id: 'job-a' });

    assert.equal(state.getAll()['job-a'], undefined);
  });

  test('a job added under an id whose files were left behind starts clean, and says so once', () => {
    const { dir, commands, lines } = env();
    populate(dir, 'job-a');

    commands['add-job'](JOB);

    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), false);
    assert.equal(exists(dir, 'telemetry/job-a.1.ndjson'), false);
    assert.equal(exists(dir, 'resource-history/job-a.ndjson'), false);
    assert.equal(exists(dir, 'logs/jobs/job-a/job-a-2026-01-01T00-00-00.log'), true);
    assert.equal(lines.filter(l => l.includes('job-a') && /left behind/.test(l)).length, 1, lines.join('\n'));
  });

  test('a job added with nothing left behind logs nothing', () => {
    const { commands, lines } = env();

    commands['add-job'](JOB);

    assert.deepEqual(lines, []);
  });
});
