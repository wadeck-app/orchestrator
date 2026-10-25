'use strict';

// The Scheduler gives every run its rotation limits: the job's `logRotation` over the daemon-wide default, for the log it
// writes itself (a direct spawn) and for the supervisor it starts (spec.json). Scripted children and FakeTime, tiny limits.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { FakeTime } = require('../src/time-service');
const { listRunSegments } = require('../src/log-rotation');

const dirs = [];
afterEach(() => { for (const d of dirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); } });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sched-logrot-')); dirs.push(d); return d; };

function scriptedChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { process.nextTick(() => child.emit('close', 143)); };
  child.ready = new Promise((resolve) => {
    child.stderr.on('newListener', (ev) => { if (ev === 'data') { resolve(); } });
  });
  return child;
}

function setup(job = {}, scheduler = {}) {
  const dir = tmp();
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  const j = { id: 'srv', type: 'startup', delaySeconds: 0, command: 'node x.js', enabled: true, triggerMode: 'wait', liveness: null, ...job };
  registry.add(j);
  return { dir, registry, state, job: j, scheduler };
}

/** One run whose child prints `lines`; returns the retained segments of the run, as text, in order. */
async function runPrinting(lines, { job, scheduler } = {}) {
  const ctx = setup(job, scheduler);
  const child = scriptedChild();
  const sched = new Scheduler(ctx.registry, ctx.state, {
    spawn: () => child, liveness: async () => false, configDir: ctx.dir, time: new FakeTime(Date.now()), ...ctx.scheduler,
  });
  const fired = sched._fire(ctx.job);
  await child.ready;
  for (const l of lines) {
    child.stdout.emit('data', Buffer.from(`${l}\n`));
  }
  child.emit('close', 0);
  await fired;
  const logDir = path.join(ctx.dir, 'logs', 'jobs', ctx.job.id);
  const runs = [...listRunSegments(logDir, ctx.job.id).values()];
  assert.equal(runs.length, 1, 'one run');
  return runs[0].map((s) => ({ n: s.n, text: fs.readFileSync(s.file, 'utf8') }));
}

const rows = (count) => Array.from({ length: count }, (_, i) => `row ${String(i).padStart(3, '0')} ${'.'.repeat(40)}`);
const joined = (segments) => segments.map((s) => s.text).join('');

describe('direct spawn', () => {
  test('a job with logRotation rotates its run log, and the daemon markers are in the right segments', async () => {
    const segs = await runPrinting(rows(60), { job: { logRotation: { maxSizeMb: 0.001, keepSegments: 1000 } } });
    assert.ok(segs.length > 3, `segments: ${segs.length}`);
    for (const r of rows(60)) {
      assert.ok(joined(segs).includes(` ${r}\n`), `${r} is missing`);
    }
    assert.match(segs[0].text, /\[job:started\]/);
    assert.match(segs[segs.length - 1].text, /\[job:finished\] exitCode=0/);
    for (const s of segs) {
      assert.ok(Buffer.byteLength(s.text) <= 1049, `segment ${s.n} is ${Buffer.byteLength(s.text)} bytes`);
    }
  });

  test('the output keeps its order across segments', async () => {
    const segs = await runPrinting(rows(40), { job: { logRotation: { maxSizeMb: 0.001, keepSegments: 1000 } } });
    const seen = joined(segs).split('\n').filter((l) => l.includes(' row ')).map((l) => l.replace(/^.*(row \d+).*$/, '$1'));
    assert.deepEqual(seen, rows(40).map((r) => r.slice(0, 7)));
  });

  test('keepSegments drops the oldest and the next segment says so', async () => {
    const segs = await runPrinting(rows(80), { job: { logRotation: { maxSizeMb: 0.001, keepSegments: 2 } } });
    assert.equal(segs.length, 2);
    assert.ok(segs[0].n > 2, 'the first segments are gone');
    assert.match(segs[1].text.split('\n')[0] + segs[0].text.split('\n')[0], /log rotation: \d+ earlier segments? of this run (was|were) dropped/);
  });

  test('without a setting the daemon-wide default applies', async () => {
    const segs = await runPrinting(rows(40), { scheduler: { logRotation: { maxBytes: 1049, keepSegments: 1000 } } });
    assert.ok(segs.length > 2, `segments: ${segs.length}`);
  });

  test('the job setting wins over the daemon-wide default, key by key', async () => {
    const segs = await runPrinting(rows(80), {
      job: { logRotation: { keepSegments: 2 } },
      scheduler: { logRotation: { maxBytes: 1049, keepSegments: 1000 } },
    });
    assert.equal(segs.length, 2, 'keepSegments from the job, maxBytes from the daemon');
  });

  test('maxSizeMb 0 on the job turns the rotation off even when the daemon rotates', async () => {
    const segs = await runPrinting(rows(80), { job: { logRotation: { maxSizeMb: 0 } }, scheduler: { logRotation: { maxBytes: 500, keepSegments: 2 } } });
    assert.equal(segs.length, 1);
  });

  test('with no option anywhere, the documented default is in force: 50 MB, not unlimited', async () => {
    // Small output stays in one segment; what is checked is that the default is a real limit.
    const { DEFAULT_RUN_LOG_ROTATION } = require('../src/scheduler');
    assert.deepEqual({ ...DEFAULT_RUN_LOG_ROTATION }, { maxBytes: 50 * 1048576, keepSegments: 5 });
    const segs = await runPrinting(rows(10));
    assert.equal(segs.length, 1);
  });
});

describe('supervised start', () => {
  async function requestFor(job, scheduler) {
    const ctx = setup(job, scheduler);
    const requests = [];
    const sched = new Scheduler(ctx.registry, ctx.state, {
      liveness: async () => false, configDir: ctx.dir, time: new FakeTime(Date.now()),
      // The request is all that is wanted: the start is refused right after, which the scheduler records as a failed start.
      supervisor: (request) => { requests.push(request); throw new Error('stop here'); },
      ...ctx.scheduler,
    });
    await sched._fire(ctx.job);
    assert.equal(requests.length, 1);
    return requests[0];
  }

  test('the request carries the resolved limits: the job over the daemon-wide default', async () => {
    const request = await requestFor({ logRotation: { maxSizeMb: 2, keepSegments: 4 } }, { logRotation: { maxBytes: 7, keepSegments: 9 } });
    assert.deepEqual(request.logRotation, { maxBytes: 2 * 1048576, keepSegments: 4 });
  });

  test('without a job setting it is the daemon-wide default', async () => {
    const request = await requestFor({}, { logRotation: { maxBytes: 1000, keepSegments: 3 } });
    assert.deepEqual(request.logRotation, { maxBytes: 1000, keepSegments: 3 });
  });

  test('rotation off is maxBytes 0', async () => {
    const request = await requestFor({ logRotation: { maxSizeMb: 0 } }, {});
    assert.equal(request.logRotation.maxBytes, 0);
  });
});
