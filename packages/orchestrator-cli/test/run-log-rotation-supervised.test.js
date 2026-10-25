'use strict';

// The log rotation with the REAL supervisor binary: it writes the job's output, the daemon (RunLogger) writes its markers into
// the same run, and the two never talk to each other. Whatever the interleaving, no line may be lost or split, the daemon's
// end marker must land in the newest segment, and the readers must see one log. Tiny limits, no sleeps beyond the polling of
// the run's end.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised } = require('../src/supervised-run');
const { listRunSegments } = require('../src/log-rotation');
const { runCli } = require('../src/cli');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const schedulers = [];
const dirs = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers.pop().stop();
  }
  for (const d of dirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

async function until(what, predicate, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const ROWS = 60;

/** Runs a job under the real supervisor that prints ROWS lines; returns the config dir once the run is over. */
async function runJob(logRotation, { daemonRotation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logrot-sup-'));
  dirs.push(dir);
  const script = path.join(dir, 'job.js');
  fs.writeFileSync(script, `for (let i = 0; i < ${ROWS}; i++) { console.log('row ' + String(i).padStart(3, '0') + ' ' + 'p'.repeat(40)); }\n`);
  const registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
  const job = {
    id: 'job', type: 'cron', schedule: '0 8 * * *', label: 'Job', enabled: true, triggerMode: 'fire-and-forget',
    command: `node "${script}"`, ...(logRotation === undefined ? {} : { logRotation }),
  };
  registry.add(job);
  const state = new State(path.join(dir, 'state.json'));
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: () => {} },
    supervisor: (request) => startSupervised({ supervisorPath, configDir: dir, heartbeatMs: 50, pollMs: 25 }, request),
    catchUpInitialDelayMs: 3_600_000,
    ...(daemonRotation === undefined ? {} : { logRotation: daemonRotation }),
  });
  schedulers.push(sched);
  await sched._fire(job);
  await until('the run to be closed', () => state.get('job')?.finishedAt !== undefined);
  return dir;
}

function segmentsOf(dir) {
  const runs = [...listRunSegments(path.join(dir, 'logs', 'jobs', 'job'), 'job').values()];
  assert.equal(runs.length, 1);
  return runs[0].map((s) => ({ n: s.n, size: s.size, text: fs.readFileSync(s.file, 'utf8') }));
}

const rowOf = (i) => `row ${String(i).padStart(3, '0')} ${'p'.repeat(40)}`;

describe('supervised run with rotation', () => {
  test('the supervisor rotates the job output and the daemon\'s markers land in the first and the last segment; nothing is lost or split', async () => {
    const dir = await runJob({ maxSizeMb: 0.002, keepSegments: 1000 });
    const segs = segmentsOf(dir);
    assert.ok(segs.length >= 3, `segments: ${segs.length}`);
    const all = segs.map((s) => s.text).join('');
    const lines = all.split('\n').filter(Boolean);
    for (const l of lines) {
      assert.match(l, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \S/, `a torn line: ${JSON.stringify(l)}`);
    }
    const rows = lines.filter((l) => l.includes(' row ')).map((l) => l.replace(/^\[[^\]]+\] /, ''));
    assert.deepEqual(rows, Array.from({ length: ROWS }, (_, i) => rowOf(i)), 'every row, once, in order');
    assert.match(segs[0].text, /\[job:started\]/);
    assert.match(segs[segs.length - 1].text, /\[job:finished\] exitCode=0/);
    for (const s of segs) {
      assert.ok(s.size <= 2097, `segment ${s.n} is ${s.size} bytes, over the 2097 limit`);
    }
  });

  test('keepSegments: the oldest are deleted, the first segment kept opens the run with a marker, with the daemon end marker in the newest', async () => {
    const dir = await runJob({ maxSizeMb: 0.002, keepSegments: 2 });
    const segs = segmentsOf(dir);
    assert.equal(segs.length, 2);
    assert.ok(segs[0].n > 1, 'segment 1 is gone');
    const markers = segs.flatMap((s) => s.text.split('\n').filter((l) => l.includes('[orch] log rotation:')));
    assert.ok(markers.length >= 1, 'a drop marker is written');
    assert.match(markers[markers.length - 1], /log rotation: \d+ earlier segments? of this run (?:was|were) dropped \(only the last 2 segments are kept, each at most 2097 bytes; see logRotation in docs\/daemon-config\.md\)/);
    assert.match(segs[segs.length - 1].text, /\[job:finished\] exitCode=0/);
    // The last row is still there: the tail of the run is what rotation keeps.
    assert.ok(segs[segs.length - 1].text.includes(rowOf(ROWS - 1)));
  });

  test('the daemon-wide default reaches the supervisor too', async () => {
    const dir = await runJob(undefined, { daemonRotation: { maxBytes: 2097, keepSegments: 1000 } });
    assert.ok(segmentsOf(dir).length >= 3);
  });

  test('maxSizeMb 0 on the job: the supervisor writes one file', async () => {
    const dir = await runJob({ maxSizeMb: 0 }, { daemonRotation: { maxBytes: 2097, keepSegments: 3 } });
    assert.equal(segmentsOf(dir).length, 1);
  });

  test('without any setting the default is 50 MB: a small run is one file', async () => {
    const dir = await runJob(undefined);
    assert.equal(segmentsOf(dir).length, 1);
  });

  test('the spec the supervisor was given carries the resolved limits', async () => {
    const dir = await runJob({ maxSizeMb: 0.002, keepSegments: 7 });
    const runsRoot = path.join(dir, 'runs', 'job');
    const spec = JSON.parse(fs.readFileSync(path.join(runsRoot, fs.readdirSync(runsRoot)[0], 'spec.json'), 'utf8'));
    assert.deepEqual(spec.logRotation, { maxBytes: 2097, keepSegments: 7 });
  });

  test('orch job <id> logs reads the rotated run as one log, and --list counts the segments', async () => {
    const dir = await runJob({ maxSizeMb: 0.002, keepSegments: 1000 });
    const out = [];
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (m) => { out.push(String(m)); };
    process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code }); };
    const send = async (command) => (command === 'get-job' ? { id: 'job' } : {});
    const sinks = { stdout: (t) => { out.push(t); }, stderr: () => {} };
    try {
      await runCli(['job', 'job', 'logs'], { send, startDaemon: () => {}, configDir: dir, jobLogs: sinks });
      const text = out.join('');
      const rows = text.split('\n').filter((l) => l.includes(' row ')).map((l) => l.replace(/^\[[^\]]+\] /, ''));
      assert.deepEqual(rows, Array.from({ length: ROWS }, (_, i) => rowOf(i)));
      out.length = 0;
      await runCli(['job', 'job', 'logs', '--list', '--json'], { send, startDaemon: () => {}, configDir: dir, jobLogs: sinks });
      const listed = JSON.parse(out.join(''));
      assert.equal(listed.length, 1);
      assert.ok(listed[0].segments >= 3);
      assert.equal(listed[0].droppedSegments, 0);
    } finally {
      console.log = origLog;
      process.exit = origExit;
    }
  });
});
