'use strict';

const { test, describe, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { EventPublisher } = require('../src/event-publisher');
const { Scheduler } = require('../src/scheduler');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

/*
 * The queue daemon's POST /push is authenticated (Authorization: Bearer <health_token>), listens on 127.0.0.1
 * only, picks its port from <queueConfigDir>/config.port and needs `cwd` in the body. The fake below enforces
 * all of it, on 127.0.0.1 only, so a publisher that guesses `localhost` or skips the header fails here.
 */

const CWD = path.resolve(os.tmpdir(), 'orch-default-cwd');
const fwd = (p) => p.split(path.sep).join('/');
const TOKEN = 'fake-token-0000000000000000000000';
const dirs = [];
const servers = [];

after(async () => {
  for (const s of servers) { await new Promise((r) => s.close(r)); }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// `acceptedToken` can change during a test: the real daemon rewrites health_token at every start.
async function fakeQueue({ acceptedToken = TOKEN } = {}) {
  const state = { received: [], acceptedToken, status: null };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method !== 'POST' || req.url !== '/push') { return send(404, { error: 'Unknown' }); }
      if (req.headers.authorization !== `Bearer ${state.acceptedToken}`) { return send(401, { error: 'Unauthorized' }); }
      if (state.status !== null) { return send(state.status, { error: 'boom' }); }
      const parsed = JSON.parse(body);
      if (typeof parsed.cwd !== 'string') { return send(500, { error: 'The "path" argument must be of type string' }); }
      state.received.push(parsed);
      send(200, { ok: true, result: { status: 'queued' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  state.port = server.address().port;
  return state;
}

function queueDir(fake, token = TOKEN) {
  const dir = tmp('orch-queue-cfg-');
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ sdkVersion: 1, port: fake.port, pid: process.pid, startedAt: new Date().toISOString() }));
  if (token !== null) { fs.writeFileSync(path.join(dir, 'health_token'), token); }
  return dir;
}

function makeLog() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

async function until(pred, what) {
  const end = Date.now() + 3000;
  while (Date.now() < end) {
    if (pred()) { return; }
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

describe('EventPublisher: delivery to the queue daemon', () => {
  test('sends the Bearer token, cwd and {event, payload} to 127.0.0.1:<port from config.port>', async () => {
    const fake = await fakeQueue();
    const pub = new EventPublisher('orchestrator', makeLog(), { queueConfigDir: queueDir(fake), cwd: CWD });
    pub.publish('job.started', { jobId: 'a', label: 'A' });
    await until(() => fake.received.length === 1, 'the event at the fake queue');
    assert.equal(fake.received[0].event, 'job.started');
    assert.deepEqual(fake.received[0].payload, { jobId: 'a', label: 'A' });
    assert.equal(fake.received[0].cwd, fwd(CWD));
  });

  test('honours QUEUE_CONFIG_DIR when no directory is given', async () => {
    const fake = await fakeQueue();
    const dir = queueDir(fake);
    const previous = process.env.QUEUE_CONFIG_DIR;
    process.env.QUEUE_CONFIG_DIR = dir;
    try {
      new EventPublisher('orchestrator', makeLog(), { cwd: CWD }).publish('job.completed', { jobId: 'a' });
      await until(() => fake.received.length === 1, 'the event at the fake queue');
    } finally {
      if (previous === undefined) { delete process.env.QUEUE_CONFIG_DIR; } else { process.env.QUEUE_CONFIG_DIR = previous; }
    }
  });

  test('re-reads the token after a 401 and retries once (the daemon rewrites it at each start)', async () => {
    const fake = await fakeQueue({ acceptedToken: 'rotated-token' });
    const dir = queueDir(fake, TOKEN);
    const log = makeLog();
    const pub = new EventPublisher('orchestrator', log, { queueConfigDir: dir, cwd: CWD });
    fs.writeFileSync(path.join(dir, 'health_token'), 'rotated-token');
    pub.publish('job.started', { jobId: 'a' });
    await until(() => fake.received.length === 1, 'delivery after the token changed');
    assert.deepEqual(log.lines, [], 'a recovered 401 must not be reported as a failure');
  });
});

describe('EventPublisher: a failure is never silent', () => {
  test('a rejected token is logged once per streak with status, path and hint, then recovery is logged', async () => {
    const fake = await fakeQueue({ acceptedToken: 'something-else' });
    const dir = queueDir(fake);
    const log = makeLog();
    const pub = new EventPublisher('orchestrator', log, { queueConfigDir: dir, cwd: CWD });
    pub.publish('job.started', { jobId: 'a' });
    pub.publish('job.completed', { jobId: 'a' });
    await until(() => log.lines.length >= 1, 'the failure line');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(log.lines.length, 1, `one line per streak, got: ${JSON.stringify(log.lines)}`);
    assert.match(log.lines[0], /401/);
    assert.ok(log.lines[0].includes(path.join(dir, 'health_token')), log.lines[0]);
    assert.match(log.lines[0], /queue status/);
    assert.ok(!log.lines[0].includes(TOKEN), 'the token must never be logged');

    fake.acceptedToken = TOKEN;
    pub.publish('job.failed', { jobId: 'a' });
    await until(() => log.lines.length >= 2, 'the recovery line');
    assert.match(log.lines[1], /recovered/i);
    assert.equal(fake.received.length, 1);
  });

  test('a non-2xx answer is a failure, whatever the status', async () => {
    const fake = await fakeQueue();
    fake.status = 503;
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: queueDir(fake), cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.match(log.lines[0], /503/);
  });

  test('a missing token file is its own explicit message', async () => {
    const fake = await fakeQueue();
    const dir = queueDir(fake, null);
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: dir, cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.ok(log.lines[0].includes(path.join(dir, 'health_token')), log.lines[0]);
    assert.match(log.lines[0], /queue start|queue status/);
  });

  test('a missing port file says the queue daemon is not running', async () => {
    const dir = tmp('orch-queue-empty-');
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: dir, cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.ok(log.lines[0].includes(path.join(dir, 'config.port')), log.lines[0]);
    assert.match(log.lines[0], /not running/);
    assert.match(log.lines[0], /queue start|queue status/);
  });

  test('a job event carries its own job cwd, other events the default one', async () => {
    const fake = await fakeQueue();
    const jobDir = path.resolve(os.tmpdir(), 'proj-with-queue');
    const pub = new EventPublisher('orchestrator', makeLog(), {
      queueConfigDir: queueDir(fake), cwd: CWD, jobCwd: (id) => (id === 'withcwd' ? jobDir : undefined),
    });
    pub.publish('job.started', { jobId: 'withcwd' });
    pub.publish('job.started', { jobId: 'nocwd' });
    pub.publish('daemon.started', { pid: 1 });
    await until(() => fake.received.length === 3, 'three events');
    const cwds = Object.fromEntries(fake.received.map((r) => [r.payload.jobId ?? r.event, r.cwd]));
    for (const c of Object.values(cwds)) { assert.equal(typeof c, 'string'); assert.ok(path.isAbsolute(c), c); }
    assert.equal(cwds.withcwd, fwd(jobDir));
    assert.equal(cwds.nocwd, fwd(CWD));
    assert.equal(cwds['daemon.started'], fwd(CWD));
  });

  test('a relative job cwd falls back to the default one; no determinable cwd is a logged failure', async () => {
    const fake = await fakeQueue();
    const dir = queueDir(fake);
    const pub = new EventPublisher('orchestrator', makeLog(), { queueConfigDir: dir, cwd: CWD, jobCwd: () => 'relative/dir' });
    pub.publish('job.started', { jobId: 'a' });
    await until(() => fake.received.length === 1, 'the event');
    assert.equal(fake.received[0].cwd, fwd(CWD));

    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: dir }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.match(log.lines[0], /cwd/);
    assert.equal(fake.received.length, 1, 'nothing may be sent without a cwd');
  });

  test('the answer body is part of the failure line', async () => {
    const fake = await fakeQueue();
    fake.status = 500;
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: queueDir(fake), cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.match(log.lines[0], /boom/);
  });

  test('publish never throws', () => {
    const pub = new EventPublisher('orchestrator', makeLog(), { queueConfigDir: path.join(os.tmpdir(), 'orch-nonexistent-queue-dir'), cwd: CWD });
    assert.doesNotThrow(() => pub.publish('job.failed', { jobId: 'x' }));
  });
});

describe('Scheduler runs reach the queue through the real publisher', () => {
  function makeEnv(exitCodes, publisher) {
    const dir = tmp('orch-evt-');
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state = new State(path.join(dir, 'state.json'));
    let n = 0;
    const sched = new Scheduler(registry, state, {
      configDir: dir,
      liveness: async () => false,
      sampleUsage: async () => null,
      spawn: () => {
        const code = exitCodes[Math.min(n++, exitCodes.length - 1)];
        const child = new EventEmitter();
        child.pid = 4242;
        process.nextTick(() => child.emit('close', code));
        return child;
      },
      eventPublisher: publisher,
    });
    return { registry, sched };
  }

  test('job.started and job.completed, then job.failed, with the fields the specs list', async () => {
    const fake = await fakeQueue();
    const jobDir = path.resolve(os.tmpdir(), 'orch-job-cwd');
    fs.mkdirSync(jobDir, { recursive: true });
    const publisher = new EventPublisher('orchestrator', makeLog(), {
      queueConfigDir: queueDir(fake), cwd: CWD, jobCwd: (id) => registry.get(id)?.cwd ?? undefined,
    });
    const { registry, sched } = makeEnv([0, 3], publisher);
    registry.add({ id: 'm1', type: 'manual', command: 'echo run', label: 'M', enabled: true, triggerMode: 'fire-and-forget', cwd: jobDir });
    await sched.start();
    try {
      await sched.trigger('m1', { kind: 'manual' }, true);
      await sched.trigger('m1', { kind: 'manual' }, true);
      await until(() => fake.received.some((r) => r.event === 'job.failed'), 'job.failed at the fake queue');
    } finally {
      await sched.stop();
    }
    for (const r of fake.received) { assert.equal(r.cwd, fwd(jobDir), `${r.event} must carry the job's cwd`); }
    const by = (name) => fake.received.filter((r) => r.event === name);
    assert.equal(by('job.started').length, 2);
    const started = by('job.started')[0].payload;
    assert.equal(started.jobId, 'm1');
    assert.equal(started.label, 'M');
    assert.equal(started.pid, 4242);
    assert.ok('trigger' in started);
    const completed = by('job.completed')[0].payload;
    assert.equal(completed.jobId, 'm1');
    assert.equal(completed.exitCode, 0);
    assert.equal(typeof completed.durationMs, 'number');
    const failed = by('job.failed')[0].payload;
    assert.equal(failed.jobId, 'm1');
    assert.equal(failed.exitCode, 3);
    assert.equal(typeof failed.durationMs, 'number');
  });
});
