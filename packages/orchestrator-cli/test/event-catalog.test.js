'use strict';

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { EVENT_CATALOG, EVENT_SOURCE } = require('../src/event-catalog');
const { EventPublisher } = require('../src/event-publisher');

const SRC = path.join(__dirname, '..', 'src');
const DOC = path.join(__dirname, '..', '..', '..', 'docs', 'daemon-config.md');

// Every event name passed to a publisher: the string literals on a line that calls publish(.
function emittedNames() {
  const names = new Set();
  for (const file of fs.readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.startsWith('event-'))) {
    for (const line of fs.readFileSync(path.join(SRC, file), 'utf8').split('\n')) {
      if (!/\bpublish\(/.test(line)) { continue; }
      for (const m of line.matchAll(/'((?:job|alert|exec|daemon)\.[a-z_]+)'/g)) { names.add(m[1]); }
    }
  }
  return names;
}

describe('event catalog: no drift between the code and the declaration', () => {
  test('the scan finds the emitters (a broken scan must not pass for an empty one)', () => {
    assert.ok(emittedNames().size >= 20, [...emittedNames()].join(', '));
  });

  test('every event the code publishes is in the catalog', () => {
    const declared = new Set(EVENT_CATALOG.map((e) => e.name));
    const missing = [...emittedNames()].filter((n) => !declared.has(n));
    assert.deepEqual(missing, [], `published but not declared in src/event-catalog.ts: ${missing.join(', ')}`);
  });

  test('every event of the catalog is published by the code', () => {
    const emitted = emittedNames();
    const stale = EVENT_CATALOG.map((e) => e.name).filter((n) => !emitted.has(n));
    assert.deepEqual(stale, [], `declared but never published: ${stale.join(', ')}`);
  });

  test('docs/daemon-config.md lists exactly the catalog names', () => {
    const doc = fs.readFileSync(DOC, 'utf8');
    const section = doc.slice(doc.indexOf('## Events pushed to the queue'), doc.indexOf('## app-core module'));
    const listed = new Set([...section.matchAll(/`((?:job|alert|exec|daemon)\.[a-z_]+)`/g)].map((m) => m[1]));
    const declared = new Set(EVENT_CATALOG.map((e) => e.name));
    assert.deepEqual([...listed].sort(), [...declared].sort());
  });
});

describe('event catalog: satisfies the queue limits and its own schemas', () => {
  test('limits', () => {
    assert.ok(EVENT_CATALOG.length <= 500);
    const seen = new Set();
    for (const e of EVENT_CATALOG) {
      assert.match(e.name, /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/);
      assert.ok(e.name.length <= 128);
      assert.ok(!seen.has(e.name), `duplicate ${e.name}`);
      seen.add(e.name);
      assert.ok(typeof e.description === 'string' && e.description.length > 0 && e.description.length <= 500, `${e.name}: description ${e.description?.length}`);
      assert.ok(Buffer.byteLength(JSON.stringify(e.schema)) <= 64 * 1024, `${e.name}: schema`);
      assert.ok(Buffer.byteLength(JSON.stringify(e.example)) <= 16 * 1024, `${e.name}: example`);
      assert.ok(e.schema && e.example !== undefined, `${e.name}: schema and example are required here`);
    }
    assert.match(EVENT_SOURCE, /^[a-z0-9][a-z0-9_-]*$/);
  });

  test('each example validates against its schema', () => {
    const Ajv = require('ajv');
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const e of EVENT_CATALOG) {
      const validate = ajv.compile(e.schema);
      assert.ok(validate(e.example), `${e.name}: ${ajv.errorsText(validate.errors)}`);
    }
  });

  test('correlation keys point at required payload fields, and terminal events say how they end', () => {
    for (const e of EVENT_CATALOG) {
      if (e.correlationKey !== undefined) {
        const key = String(e.correlationKey).replace(/^payload\./, '');
        assert.ok(e.schema.required.includes(key), `${e.name}: ${key} is not a required field`);
      }
      if (e.terminal === true) {
        assert.ok(['success', 'failure', 'info'].includes(e.outcome), `${e.name}: terminal needs an outcome`);
      }
    }
  });

  test('"finished = any terminal event" never double counts: the terminal job events are exclusive per run', () => {
    const terminal = EVENT_CATALOG.filter((e) => e.terminal).map((e) => e.name).sort();
    assert.deepEqual(terminal, ['exec.completed', 'exec.failed', 'job.completed', 'job.failed', 'job.killed_manual', 'job.skipped']);
    const notTerminal = ['job.timed_out', 'job.kill_requested', 'job.triggered_manual', 'job.restarted', 'job.started'];
    for (const n of notTerminal) {
      assert.ok(!EVENT_CATALOG.find((e) => e.name === n).terminal, `${n} must not be terminal`);
    }
  });
});

describe('declaring the catalog to a queue daemon', () => {
  const { startFakeQueueDaemon } = require('@wadeck-app/queue-sdk/testing');
  const saved = {};
  const daemons = [];

  beforeEach(() => {
    for (const k of ['QUEUE_SDK_OFF', 'QUEUE_CONFIG_DIR']) { saved[k] = process.env[k]; }
    process.env.QUEUE_SDK_OFF = '0';
  });
  afterEach(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; } }
  });
  after(async () => { for (const d of daemons) { await d.close(); } });

  async function setup(options) {
    const daemon = await startFakeQueueDaemon(options);
    daemons.push(daemon);
    process.env.QUEUE_CONFIG_DIR = daemon.configDir;
    const lines = [];
    const cwd = path.resolve(os.tmpdir(), 'orch-catalog-cwd');
    const publisher = new EventPublisher('orchestrator', { write: (l) => lines.push(l) }, { cwd });
    return { daemon, lines, publisher };
  }

  test('the daemon receives source "orchestrator" with every event, and one line says how many', async () => {
    const { daemon, lines, publisher } = await setup();
    await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    const [reg] = daemon.registrations();
    assert.equal(reg.source, 'orchestrator');
    assert.deepEqual(reg.events.map((e) => e.name), EVENT_CATALOG.map((e) => e.name));
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], new RegExp(`${EVENT_CATALOG.length} event`));
  });

  test('rejected: the problem paths are logged, with what to fix', async () => {
    const { daemon, lines, publisher } = await setup();
    daemon.respondNextRegistration({ status: 'rejected', reason: 'events[3].name: bad', problems: [{ path: 'events[3].name', message: 'bad segment' }] });
    await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /events\[3\]\.name/);
    assert.match(lines[0], /event-catalog\.ts/);
  });

  test('unsupported: says to update the queue', async () => {
    const { daemon, lines, publisher } = await setup({ protocolVersion: '1.0.0' });
    await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    assert.equal(daemon.registrations().length, 0);
    assert.equal(lines.length, 1, JSON.stringify(lines));
    assert.match(lines[0], /older than protocol 1\.1\.0: run queue cli update/);
  });

  test('QUEUE_SDK_OFF=1: nothing is sent and nothing is logged as an error', async () => {
    const { daemon, lines, publisher } = await setup();
    process.env.QUEUE_SDK_OFF = '1';
    await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    assert.equal(daemon.registrations().length, 0);
    assert.ok(!lines.some((l) => /fail|reject|older|could not/i.test(l)), JSON.stringify(lines));
  });

  test('a declaration the daemon did not take is retried once, at the first successful publish', async () => {
    const { daemon, lines, publisher } = await setup();
    daemon.respondNextRegistration({ status: 'weird' });
    const first = await publisher.declareEvents(EVENT_SOURCE, EVENT_CATALOG);
    assert.equal(first, 'dropped');
    assert.equal(daemon.registrations().length, 1);
    assert.ok(lines.length >= 1, 'the failed declaration is logged');

    publisher.publish('job.started', { jobId: 'a' });
    await publisher.flush();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(daemon.registrations().length, 2, 'retried once after the first accepted publish');

    publisher.publish('job.completed', { jobId: 'a' });
    await publisher.flush();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(daemon.registrations().length, 2, 'not retried again');
  });
});
