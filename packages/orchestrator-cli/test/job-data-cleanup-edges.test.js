'use strict';

// The edges of what removing / adding a job deletes (src/job-data-cleanup.ts and the remove-job / add-job commands):
// hostile ids, a job that is still running, the decision matrix for run folders, locked paths.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { removeJobData, dropStaleJobData } = require('../src/job-data-cleanup');
const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];
function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cleanup-edges-'));
  tmpDirs.push(dir);
  return dir;
}
after(() => { for (const dir of tmpDirs) { fs.rmSync(dir, { recursive: true, force: true }); } });

function put(dir, rel, content = 'x') {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}
const exists = (dir, rel) => fs.existsSync(path.join(dir, ...rel.split('/')));

function putRun(dir, jobId, name, { state, done = false, raw }) {
  put(dir, `runs/${jobId}/${name}/spec.json`, '{}');
  put(dir, `runs/${jobId}/${name}/status.json`, raw ?? JSON.stringify({ state, supervisorPid: 1 }));
  if (done) { put(dir, `runs/${jobId}/${name}/done`, ''); }
}

function populate(dir, id) {
  put(dir, `telemetry/${id}.ndjson`);
  put(dir, `telemetry/${id}.1.ndjson`);
  put(dir, `resource-history/${id}.ndjson`);
  put(dir, `resource-history/${id}.ndjson.tmp`);
  put(dir, `progress/${id}.json`);
  put(dir, `progress/${id}.json.tmp`);
  put(dir, `logs/jobs/${id}/${id}-2026-01-01T00-00-00.log`, 'a log');
  fs.mkdirSync(path.join(dir, 'tmp', id), { recursive: true });
}

describe('removeJobData: ids at function level', () => {
  test('a valid id with an uppercase letter or a leading "-" is accepted (the rule is letters, digits and "-")', () => {
    for (const id of ['JOB-A', '-lead', 'a']) {
      const dir = makeDir();
      put(dir, `telemetry/${id}.ndjson`);

      const result = removeJobData(dir, id);

      assert.equal(exists(dir, `telemetry/${id}.ndjson`), false, id);
      assert.equal(result.cleaned.telemetry, 1, id);
      assert.deepEqual(result.leftovers, [], id);
    }
  });

  test('an id with unicode letters, a trailing newline, a NUL or a space is refused with a message that names it', () => {
    for (const id of ['jöb', 'job-a\n', 'job\u0000a', 'job a', '日本']) {
      const dir = makeDir();
      put(dir, 'telemetry/job-a.ndjson');

      const result = removeJobData(dir, id);

      assert.equal(result.leftovers.length, 1, JSON.stringify(id));
      assert.equal(result.leftovers[0].reason, `${JSON.stringify(id)} is not a valid job id (letters, digits and "-" only), nothing was deleted`);
      assert.equal(exists(dir, 'telemetry/job-a.ndjson'), true);
    }
  });

  test('a non-string id is refused too, never coerced into a path', () => {
    const dir = makeDir();
    put(dir, 'telemetry/undefined.ndjson');
    put(dir, 'telemetry/42.ndjson');

    for (const id of [undefined, 42, null, {}, ['job-a']]) {
      const result = removeJobData(dir, id);
      assert.equal(result.leftovers.length, 1);
      assert.match(result.leftovers[0].reason, /not a valid job id/);
    }
    assert.equal(exists(dir, 'telemetry/undefined.ndjson'), true);
    assert.equal(exists(dir, 'telemetry/42.ndjson'), true);
  });

  test('a very long valid id does not throw: nothing to delete, nothing reported', () => {
    const dir = makeDir();

    const result = removeJobData(dir, 'a'.repeat(400));

    assert.deepEqual(result, { cleaned: { telemetry: 0, resourceHistory: 0, progress: 0, runs: 0 }, leftovers: [] });
  });
});

describe('removeJobData: a job that is still running', () => {
  test('keeps telemetry, resource history, learned progress data and tmp/<id>; each file is its own leftover, rotated and .tmp ones included', () => {
    const dir = makeDir();
    populate(dir, 'job-a');

    const result = removeJobData(dir, 'job-a', { running: true });

    for (const rel of ['telemetry/job-a.ndjson', 'telemetry/job-a.1.ndjson', 'resource-history/job-a.ndjson', 'resource-history/job-a.ndjson.tmp', 'progress/job-a.json', 'progress/job-a.json.tmp']) {
      assert.equal(exists(dir, rel), true, rel);
    }
    assert.equal(exists(dir, 'tmp/job-a'), true, 'the default cwd of the run in progress stays');
    assert.deepEqual(result.cleaned, { telemetry: 0, resourceHistory: 0, progress: 0, runs: 0 });
    assert.deepEqual(
      result.leftovers.map((l) => path.basename(l.path)).sort(),
      ['job-a.1.ndjson', 'job-a.json', 'job-a.json.tmp', 'job-a.ndjson', 'job-a.ndjson', 'job-a.ndjson.tmp'].sort(),
    );
    assert.ok(result.leftovers.every((l) => /the job is still running/.test(l.reason)));
  });

  test('a leftover is only reported for a file that exists', () => {
    const dir = makeDir();
    put(dir, 'telemetry/job-a.ndjson');

    const result = removeJobData(dir, 'job-a', { running: true });

    assert.equal(result.leftovers.length, 1);
    assert.match(result.leftovers[0].reason, /its telemetry is written by the run in progress/);
  });

  test('the running callback is asked only when there is something to delete, and once', () => {
    const dir = makeDir();
    let asked = 0;
    const running = () => { asked++; return false; };

    removeJobData(dir, 'job-a', { running });
    dropStaleJobData(dir, 'job-a', { running });
    assert.equal(asked, 0, 'nothing on disk: the (possibly expensive) question is not asked');

    populate(dir, 'job-a');
    removeJobData(dir, 'job-a', { running });
    assert.equal(asked, 1, 'asked once for the whole removal');
  });

  test('the running callback answering true is honoured by the tmp folder as well', () => {
    const dir = makeDir();
    populate(dir, 'job-a');

    removeJobData(dir, 'job-a', { running: () => true });

    assert.equal(exists(dir, 'tmp/job-a'), true);
    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), true);
  });
});

describe('removeJobData: which run folders go', () => {
  test('`done` wins over a status that still says running', () => {
    const dir = makeDir();
    putRun(dir, 'job-a', 'r1', { state: 'running', done: true });

    const result = removeJobData(dir, 'job-a');

    assert.equal(result.cleaned.runs, 1);
    assert.equal(exists(dir, 'runs/job-a'), false);
  });

  test('a state other than running (crashed, exited, anything textual) is finished and goes', () => {
    const dir = makeDir();
    putRun(dir, 'job-a', 'r1', { state: 'crashed' });
    putRun(dir, 'job-a', 'r2', { state: 'exited' });
    putRun(dir, 'job-a', 'r3', { state: 'something-new' });

    const result = removeJobData(dir, 'job-a');

    assert.equal(result.cleaned.runs, 3);
    assert.deepEqual(result.leftovers, []);
    assert.equal(exists(dir, 'runs/job-a'), false, 'the emptied folder of the job goes too');
  });

  test('a state that is not a string leaves the folder and says status.json has no state; the root stays', () => {
    const dir = makeDir();
    putRun(dir, 'job-a', 'r1', { raw: JSON.stringify({ state: 5 }) });
    putRun(dir, 'job-a', 'r2', { raw: '{}' });
    putRun(dir, 'job-a', 'r3', { state: 'exited' });

    const result = removeJobData(dir, 'job-a');

    assert.equal(result.cleaned.runs, 1);
    assert.equal(exists(dir, 'runs/job-a/r1'), true);
    assert.equal(exists(dir, 'runs/job-a/r2'), true);
    assert.equal(exists(dir, 'runs/job-a/r3'), false);
    assert.equal(result.leftovers.length, 2);
    assert.ok(result.leftovers.every((l) => l.reason === 'status.json has no state, the run folder is left in place'));
  });

  test('runs/<id> being a file is reported with its path, not thrown, and left alone', () => {
    const dir = makeDir();
    const file = put(dir, 'runs/job-a', 'not a folder');

    const result = removeJobData(dir, 'job-a');

    assert.equal(fs.readFileSync(file, 'utf8'), 'not a folder');
    assert.equal(result.leftovers.length, 1);
    assert.equal(result.leftovers[0].path, file);
    assert.ok(result.leftovers[0].reason.length > 0);
  });

  test('a run folder that cannot be deleted (locked) is reported with its path; the others go; the root stays', () => {
    const dir = makeDir();
    putRun(dir, 'job-a', 'r1', { state: 'exited' });
    putRun(dir, 'job-a', 'r2', { state: 'exited' });
    const locked = path.join(dir, 'runs', 'job-a', 'r1');
    const lockedFs = {
      ...fs,
      rmSync: (p, o) => {
        if (p === locked) {
          throw Object.assign(new Error(`EBUSY: resource busy or locked, rmdir '${p}'`), { code: 'EBUSY' });
        }
        return fs.rmSync(p, o);
      },
    };

    const result = removeJobData(dir, 'job-a', { fs: lockedFs });

    assert.equal(result.cleaned.runs, 1);
    assert.equal(exists(dir, 'runs/job-a/r1'), true);
    assert.equal(exists(dir, 'runs/job-a/r2'), false);
    assert.deepEqual(result.leftovers.map((l) => l.path), [locked]);
    assert.match(result.leftovers[0].reason, /EBUSY/);
  });

  test('a job whose id is the prefix of another job\'s is the only one touched', () => {
    const dir = makeDir();
    populate(dir, 'job-a');
    populate(dir, 'job-ab');
    putRun(dir, 'job-a', 'r1', { state: 'exited' });
    putRun(dir, 'job-ab', 'r1', { state: 'exited' });

    removeJobData(dir, 'job-a');

    for (const rel of ['telemetry/job-ab.ndjson', 'telemetry/job-ab.1.ndjson', 'resource-history/job-ab.ndjson', 'progress/job-ab.json', 'runs/job-ab/r1/status.json', 'tmp/job-ab']) {
      assert.equal(exists(dir, rel), true, rel);
    }
    assert.equal(exists(dir, 'telemetry/job-a.ndjson'), false);
    assert.equal(exists(dir, 'runs/job-a'), false);
  });

  test('the logs of the job survive, folder and files', () => {
    const dir = makeDir();
    populate(dir, 'job-a');

    removeJobData(dir, 'job-a');

    assert.equal(exists(dir, 'logs/jobs/job-a/job-a-2026-01-01T00-00-00.log'), true);
  });
});

describe('remove-job and add-job through the commands: edges', () => {
  function env({ running = 0 } = {}) {
    const dir = makeDir();
    const entries = [];
    const lines = [];
    const removed = [];
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    const scheduler = {
      killJob: async () => ({ killed: false }), skipNextFiring: () => {},
      scheduleJob: () => {}, unscheduleJob: (id) => removed.push(id),
      runningCount: () => running,
    };
    const audit = { log: (event, payload) => entries.push({ event, payload }) };
    const commands = makeCommands(registry, state, scheduler, dir, undefined, audit, undefined, undefined, undefined, (l) => lines.push(l));
    return { dir, commands, entries, lines, state, removed };
  }
  const JOB = { id: 'job-a', type: 'manual', command: 'node -v', label: 'A' };

  test('removing an id that is not a job fails with the id and a hint, and deletes nothing', () => {
    const { dir, commands, entries } = env();
    commands['add-job'](JOB);
    populate(dir, 'ghost');

    assert.throws(() => commands['remove-job']({ id: 'ghost' }), /ghost/);

    assert.equal(exists(dir, 'telemetry/ghost.ndjson'), true, 'files of an id that is not a job are not this command\'s to delete');
    assert.equal(entries.some((e) => e.event === 'job.deleted'), false);
  });

  test('hostile and malformed ids are refused before anything is deleted or audited', () => {
    const { dir, commands, entries, removed } = env();
    commands['add-job'](JOB);
    const root = path.dirname(dir);
    const sentinel = path.join(root, 'orch-cleanup-edges-sentinel.ndjson');
    fs.writeFileSync(sentinel, 'x');
    try {
      put(dir, 'telemetry/x.ndjson');
      for (const id of ['../x', '..', '../orch-cleanup-edges-sentinel', undefined, 42, null, '']) {
        assert.throws(() => commands['remove-job']({ id }), undefined, JSON.stringify(id));
      }
      assert.equal(fs.existsSync(sentinel), true);
      assert.equal(exists(dir, 'telemetry/x.ndjson'), true);
      assert.equal(entries.some((e) => e.event === 'job.deleted'), false);
      assert.deepEqual(removed, [], 'no job was unscheduled either');
    } finally {
      fs.rmSync(sentinel, { force: true });
    }
  });

  test('a job with a running instance keeps its history in state.json too', () => {
    const { commands, state } = env({ running: 1 });
    commands['add-job'](JOB);
    state.record('job-a', { startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), exitCode: 0, pid: 1 });

    commands['remove-job']({ id: 'job-a' });

    assert.ok(state.getAll()['job-a'], 'the run in progress still writes its record');
  });

  test('the audit payload carries counts, never a path', () => {
    const { dir, commands, entries } = env({ running: 1 });
    commands['add-job'](JOB);
    populate(dir, 'job-a');

    commands['remove-job']({ id: 'job-a' });

    const text = JSON.stringify(entries.find((e) => e.event === 'job.deleted').payload);
    assert.equal(text.includes(dir.replace(/\\/g, '\\\\')), false, text);
    assert.equal(text.includes(dir), false, text);
    assert.equal(/ndjson|\.json|[\\/]/.test(text), false, text);
    assert.deepEqual(JSON.parse(text).cleaned, { telemetry: 0, resourceHistory: 0, progress: 0, runs: 0 });
  });

  test('adding a duplicate id fails and drops nothing: the first job\'s data stays', () => {
    const { dir, commands, lines } = env();
    commands['add-job'](JOB);
    populate(dir, 'job-a');

    assert.throws(() => commands['add-job'](JOB), /job-a/);

    for (const rel of ['telemetry/job-a.ndjson', 'telemetry/job-a.1.ndjson', 'resource-history/job-a.ndjson', 'progress/job-a.json']) {
      assert.equal(exists(dir, rel), true, rel);
    }
    assert.deepEqual(lines, []);
  });
});
