'use strict';

const { test, describe, after, beforeEach, afterEach } = require('node:test');
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
 * Transport (daemon discovery, token, `queue start`, retries) is @wadeck-app/queue-sdk's. These tests use the real
 * SDK against a fake queue daemon on 127.0.0.1 that answers /version and /push like the real one (see queue's
 * docs/push-protocol.md), reached through a QUEUE_CONFIG_DIR with config.port + health_token. They check what
 * orchestrator decides: which cwd, the log lines, flush, never throwing.
 */

const CWD = path.resolve(os.tmpdir(), 'orch-default-cwd');
const TOKEN = 'fake-token-0000000000000000000000';
const originalPath = process.env.PATH;
const dirs = [];
const servers = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// The SDK would run a `queue` found on PATH to start a stopped daemon: none is visible to these tests.
beforeEach(() => { process.env.PATH = tmp('orch-no-queue-bin-'); });
afterEach(() => { process.env.PATH = originalPath; });
after(async () => {
  for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
});

const fwd = (p) => path.normalize(p);

async function fakeQueue({ acceptedToken = TOKEN, hang = false } = {}) {
  const dir = tmp('orch-queue-cfg-');
  const state = { received: [], acceptedToken, dir };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/version') {
      return send(200, {
        version: '2026.10.23-fake', pid: process.pid, config_dir: dir, sdkVersion: 1, port: state.port,
        queueProtocol: { version: '1.0.0', accepts: '^1.0.0' },
      });
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (hang) { return; }
      if (req.method !== 'POST' || req.url !== '/push') { return send(404, { error: 'Unknown' }); }
      if (req.headers.authorization !== `Bearer ${state.acceptedToken}`) { return send(401, { error: 'Unauthorized' }); }
      const parsed = JSON.parse(body);
      if (typeof parsed.cwd !== 'string') { return send(500, { error: 'The "path" argument must be of type string' }); }
      state.received.push(parsed);
      send(200, { ok: true, result: { status: 'queued', eventId: `e${state.received.length}`, subscriberCount: 0 } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  state.port = server.address().port;
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ sdkVersion: 1, port: state.port, pid: process.pid, startedAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(dir, 'health_token'), TOKEN);
  return state;
}

function withQueueDir(dir, fn) {
  const previous = process.env.QUEUE_CONFIG_DIR;
  process.env.QUEUE_CONFIG_DIR = dir;
  try { return fn(); } finally {
    if (previous === undefined) { delete process.env.QUEUE_CONFIG_DIR; } else { process.env.QUEUE_CONFIG_DIR = previous; }
  }
}

// The SDK reads QUEUE_CONFIG_DIR when the publisher is built (the first publish), so it is set around the build.
function makePublisher(queueDir, options = {}) {
  const lines = [];
  const publisher = withQueueDir(queueDir, () => {
    const p = new EventPublisher('orchestrator', { write: (l) => lines.push(l) }, { cwd: CWD, ...options });
    p.publish('orch.warmup', {});
    return p;
  });
  return { publisher, lines };
}

async function until(pred, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) { return; }
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

describe('EventPublisher on the queue SDK', () => {
  test('delivers {event, payload, cwd}: a job event with its own cwd, the others with the default', async () => {
    const fake = await fakeQueue();
    const jobDir = path.resolve(os.tmpdir(), 'proj-with-queue');
    const { publisher, lines } = makePublisher(fake.dir, { jobCwd: (id) => (id === 'withcwd' ? jobDir : (id === 'rel' ? 'relative/dir' : undefined)) });
    publisher.publish('job.started', { jobId: 'withcwd', label: 'A' });
    publisher.publish('job.started', { jobId: 'nocwd' });
    publisher.publish('job.started', { jobId: 'rel' });
    publisher.publish('daemon.started', { pid: 1 });
    await until(() => fake.received.length === 5, 'five events (warmup included)');
    const byKey = Object.fromEntries(fake.received.map((r) => [r.payload.jobId ?? r.event, r]));
    for (const r of fake.received) { assert.ok(path.isAbsolute(r.cwd), r.cwd); }
    assert.equal(path.normalize(byKey.withcwd.cwd), fwd(jobDir));
    assert.deepEqual(byKey.withcwd.payload, { jobId: 'withcwd', label: 'A' });
    assert.equal(path.normalize(byKey.nocwd.cwd), fwd(CWD));
    assert.equal(path.normalize(byKey.rel.cwd), fwd(CWD), 'a relative job cwd means nothing to the daemon');
    assert.equal(path.normalize(byKey['daemon.started'].cwd), fwd(CWD));
    assert.deepEqual(lines, []);
  });

  test('a rejected token is logged once per streak, then recovery is logged', async () => {
    const fake = await fakeQueue({ acceptedToken: 'something-else' });
    const { publisher, lines } = makePublisher(fake.dir);
    publisher.publish('job.started', { jobId: 'a' });
    publisher.publish('job.completed', { jobId: 'a' });
    await until(() => lines.length >= 1, 'the failure line');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(lines.length, 1, `one line per streak, got: ${JSON.stringify(lines)}`);
    assert.match(lines[0], /unauthorized|401|token|config/i);
    assert.ok(!lines[0].includes(TOKEN));

    fake.acceptedToken = TOKEN;
    publisher.publish('job.failed', { jobId: 'a' });
    await until(() => lines.length >= 2, 'the recovery line');
    assert.match(lines[1], /recovered/i);
  });

  test('daemon stopped and no queue CLI: one explicit line with what to do', async () => {
    const dir = tmp('orch-queue-empty-');
    const { publisher, lines } = makePublisher(dir);
    publisher.publish('job.started', { jobId: 'a' });
    await until(() => lines.length >= 1, 'the failure line');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /not-installed|queue/i);
  });

  test('no absolute cwd is a logged failure and nothing is sent', async () => {
    const fake = await fakeQueue();
    const lines = [];
    const publisher = withQueueDir(fake.dir, () => new EventPublisher('orchestrator', { write: (l) => lines.push(l) }, {}));
    publisher.publish('job.started', { jobId: 'a' });
    await until(() => lines.length === 1, 'the failure line');
    assert.match(lines[0], /cwd/);
    assert.equal(fake.received.length, 0);
  });

  test('publish never throws and does not wait for the queue', async () => {
    const fake = await fakeQueue({ hang: true });
    const { publisher } = makePublisher(fake.dir);
    const t0 = Date.now();
    assert.doesNotThrow(() => publisher.publish('job.started', { jobId: 'a' }));
    assert.ok(Date.now() - t0 < 100);
  });

  test('off: nothing is sent and nothing is logged', async () => {
    const fake = await fakeQueue();
    const { publisher, lines } = makePublisher(fake.dir, { off: true });
    publisher.publish('job.started', { jobId: 'a' });
    await publisher.flush();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.received.length, 0);
    assert.deepEqual(lines, []);
  });

  test('flush waits for the pushes in flight, bounded when the queue hangs', async () => {
    const live = await fakeQueue();
    const a = makePublisher(live.dir);
    a.publisher.publish('job.completed', { jobId: 'a' });
    await a.publisher.flush();
    assert.equal(live.received.some((r) => r.event === 'job.completed'), true, 'flush returned before the push landed');

    const hung = await fakeQueue({ hang: true });
    const b = makePublisher(hung.dir, { flushBoundMs: 300 });
    b.publisher.publish('job.completed', { jobId: 'a' });
    const t0 = Date.now();
    await b.publisher.flush();
    assert.ok(Date.now() - t0 < 1500, `flush took ${Date.now() - t0} ms`);
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
    const { publisher } = makePublisher(fake.dir, { jobCwd: (id) => registry.get(id)?.cwd ?? undefined });
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
    const jobEvents = fake.received.filter((r) => r.event.startsWith('job.'));
    for (const r of jobEvents) { assert.equal(path.normalize(r.cwd), fwd(jobDir), `${r.event} must carry the job's cwd`); }
    const by = (name) => jobEvents.filter((r) => r.event === name);
    assert.equal(by('job.started').length, 2);
    const started = by('job.started')[0].payload;
    assert.equal(started.jobId, 'm1');
    assert.equal(started.label, 'M');
    assert.equal(started.pid, 4242);
    assert.ok('trigger' in started);
    const completed = by('job.completed')[0].payload;
    assert.equal(completed.exitCode, 0);
    assert.equal(typeof completed.durationMs, 'number');
    const failed = by('job.failed')[0].payload;
    assert.equal(failed.jobId, 'm1');
    assert.equal(failed.exitCode, 3);
    assert.equal(typeof failed.durationMs, 'number');
  });
});
