'use strict';

// audit.ndjson reached 3 MB / 13 407 lines, 12 550 of them `job.triggered_manual` with `"jobId":""`
// (all 2026-09-05): the trigger handler audited BEFORE looking at the id, so a request for no job at
// all was recorded as a manual trigger. Nothing rotated the file, and `job.completed` carried neither
// a duration nor what started the run.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const { EventEmitter } = require('node:events');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { makeCommands } = require('../src/commands');
const { AuditLogger } = require('../src/audit');
const { wireAuditEvents } = require('../src/audit-wiring');
const { loadDaemonConfig } = require('../src/daemonConfig');

const dirs = [];
after(() => {
  for (const dir of dirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe('trigger-job refuses a request that names no real job, before auditing it', () => {
  function env() {
    const dir = tmp('orch-audit-trigger-');
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    registry.add({ id: 'j1', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' });
    const sched = new Scheduler(registry, state, {
      spawn: () => { const c = new EventEmitter(); c.pid = 1; setTimeout(() => c.emit('close', 0), 5); return c; },
      // The fake child claims pid 1, the root of every process on the machine: measuring it for real walked them all.
      sampleUsage: async () => null,
      liveness: async () => false,
      eventPublisher: { publish: () => {} },
      configDir: dir,
    });
    const logged = [];
    const audit = { log: (event, payload) => logged.push({ event, payload }), readLast: () => [] };
    const commands = makeCommands(registry, state, sched, dir, undefined, audit);
    return { commands, logged };
  }

  test('an empty id is refused with a message that says what an id looks like', () => {
    const { commands, logged } = env();

    assert.throws(() => commands['trigger-job']({ id: '' }), /job id.*orch list/is);
    assert.deepEqual(logged, [], 'an empty id must leave no audit entry');
  });

  test('an id that could escape the logs directory is refused', () => {
    const { commands, logged } = env();

    assert.throws(() => commands['trigger-job']({ id: '../etc' }), /orch list/);
    assert.deepEqual(logged, []);
  });

  test('a well-formed id that is not registered is refused and not audited', () => {
    const { commands, logged } = env();

    assert.throws(() => commands['trigger-job']({ id: 'ghost' }), /Job not found: "ghost".*orch list/s);
    assert.deepEqual(logged, []);
  });

  test('a real job is still triggered and audited once', async () => {
    const { commands, logged } = env();

    await commands['trigger-job']({ id: 'j1' });

    assert.equal(logged.length, 1);
    assert.equal(logged[0].event, 'job.triggered_manual');
    assert.equal(logged[0].payload.jobId, 'j1');
  });
});

describe('a manual trigger refused by maxConcurrency leaves a trace of the refusal', () => {
  test('the trail says it was refused, why, and how full the job was', async () => {
    const { FakeTime } = require('../src/time-service');
    const dir = tmp('orch-audit-refused-');
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    registry.add({ id: 'j1', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget', maxConcurrency: 1 });
    const children = [];
    const sched = new Scheduler(registry, state, {
      // Never ends on its own: the first run has to still be alive when the second is asked for.
      spawn: () => { const c = new EventEmitter(); c.pid = 9000 + children.length; children.push(c); return c; },
      liveness: async () => false,
      sampleUsage: async () => null,
      eventPublisher: { publish: () => {} },
      configDir: dir,
      time: new FakeTime(),
    });
    const logged = [];
    const audit = { log: (event, payload) => logged.push({ event, payload }), readLast: () => [] };
    const commands = makeCommands(registry, state, sched, dir, undefined, audit);

    await commands['trigger-job']({ id: 'j1', ip: '127.0.0.1' });
    const second = await commands['trigger-job']({ id: 'j1', ip: '127.0.0.1' });

    assert.equal(second.status, 'already-running');
    const refused = logged.filter((e) => e.event === 'job.trigger_refused');
    assert.equal(refused.length, 1);
    assert.deepEqual(
      { jobId: refused[0].payload.jobId, reason: refused[0].payload.reason, running: refused[0].payload.running, maxConcurrency: refused[0].payload.maxConcurrency },
      { jobId: 'j1', reason: 'concurrency', running: 1, maxConcurrency: 1 },
    );
    children[0].emit('close', 0);
  });

  test('a trigger that started is not reported as refused', async () => {
    const dir = tmp('orch-audit-started-');
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    registry.add({ id: 'j1', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' });
    const sched = new Scheduler(registry, state, {
      spawn: () => { const c = new EventEmitter(); c.pid = 1; setTimeout(() => c.emit('close', 0), 5); return c; },
      // The fake child claims pid 1, the root of every process on the machine: measuring it for real walked them all.
      sampleUsage: async () => null,
      liveness: async () => false,
      eventPublisher: { publish: () => {} },
      configDir: dir,
    });
    const logged = [];
    const audit = { log: (event, payload) => logged.push({ event, payload }), readLast: () => [] };
    const commands = makeCommands(registry, state, sched, dir, undefined, audit);

    await commands['trigger-job']({ id: 'j1' });

    assert.equal(logged.filter((e) => e.event === 'job.trigger_refused').length, 0);
  });
});

describe('audit.ndjson is rotated by size and stays readable across files', () => {
  const rotated = (dir) => fs.readdirSync(dir).filter((f) => /^audit\..+\.ndjson$/.test(f)).sort();

  test('past maxBytes the live file moves to audit.<timestamp>.ndjson and a fresh one starts', () => {
    const dir = tmp('orch-audit-rot-');
    const audit = new AuditLogger(dir, { maxBytes: 400, maxFiles: 5 });

    for (let i = 0; i < 20; i++) {
      audit.log('job.completed', { jobId: 'j1', n: i });
    }

    assert.ok(rotated(dir).length >= 1, 'nothing was rotated');
    assert.ok(fs.statSync(path.join(dir, 'audit.ndjson')).size <= 400 + 120,
      'the live file kept growing past the limit');
  });

  test('only maxFiles rotated files are kept, the newest ones', () => {
    const dir = tmp('orch-audit-keep-');
    const audit = new AuditLogger(dir, { maxBytes: 200, maxFiles: 2 });

    for (let i = 0; i < 60; i++) {
      audit.log('job.completed', { jobId: 'j1', n: i });
    }

    assert.equal(rotated(dir).length, 2);
    assert.equal(audit.readLast(1)[0].n, 59, 'the newest entry must be the first one returned');
  });

  test('readLast reaches back into rotated files when the live one is short', () => {
    const dir = tmp('orch-audit-read-');
    const audit = new AuditLogger(dir, { maxBytes: 300, maxFiles: 10 });

    for (let i = 0; i < 25; i++) {
      audit.log('job.completed', { jobId: 'j1', n: i });
    }
    const live = fs.readFileSync(path.join(dir, 'audit.ndjson'), 'utf8').trim().split('\n').length;
    assert.ok(live < 25, 'precondition: the live file alone must not hold everything');

    const last = audit.readLast(25);

    assert.deepEqual(last.map((e) => e.n), Array.from({ length: 25 }, (_, i) => 24 - i));
  });

  test('maxBytes 0 turns rotation off', () => {
    const dir = tmp('orch-audit-off-');
    const audit = new AuditLogger(dir, { maxBytes: 0, maxFiles: 5 });

    for (let i = 0; i < 50; i++) {
      audit.log('job.completed', { jobId: 'j1', n: i });
    }

    assert.deepEqual(rotated(dir), []);
  });

  test('a torn line does not blank the whole trail', () => {
    const dir = tmp('orch-audit-torn-');
    const audit = new AuditLogger(dir);
    audit.log('job.completed', { jobId: 'a' });
    fs.appendFileSync(path.join(dir, 'audit.ndjson'), '{"ts":"2026-01-01","event":"half');
    fs.appendFileSync(path.join(dir, 'audit.ndjson'), '\n');
    audit.log('job.completed', { jobId: 'b' });

    assert.deepEqual(audit.readLast(10).map((e) => e.jobId), ['b', 'a']);
  });

  test('defaults keep the trail bounded without any configuration', () => {
    const dir = tmp('orch-audit-defaults-');
    const cfg = loadDaemonConfig(dir);

    assert.ok(cfg.auditMaxBytes > 0, 'rotation must be on by default');
    assert.ok(cfg.auditMaxFiles >= 1);
  });

  test('config.yml sets both limits, and a bad value warns and falls back', () => {
    const dir = tmp('orch-audit-cfg-');
    fs.writeFileSync(path.join(dir, 'config.yml'), 'auditMaxBytes: 1000\nauditMaxFiles: lots\n');
    const warnings = [];

    const cfg = loadDaemonConfig(dir, (m) => warnings.push(m));

    assert.equal(cfg.auditMaxBytes, 1000);
    assert.ok(warnings.some((w) => /auditMaxFiles/.test(w)), `no warning for the bad value: ${warnings}`);
  });
});

describe('job.completed and job.skipped say how long it took and what started it', () => {
  function wire() {
    const scheduler = new EventEmitter();
    const logged = [];
    wireAuditEvents(scheduler, { log: (event, payload) => logged.push({ event, payload }) });
    return { scheduler, logged };
  }
  const JOB = { label: 'Scraper' };

  test('a completion carries durationMs and the trigger kind', () => {
    const { scheduler, logged } = wire();

    scheduler.emit('job-finished', { id: 'wa', exitCode: 0, job: JOB, durationMs: 4200, trigger: { kind: 'cron' } });

    assert.equal(logged[0].payload.durationMs, 4200);
    assert.equal(logged[0].payload.trigger, 'cron');
    assert.equal(logged[0].payload.exitCode, 0, 'existing fields stay');
  });

  test('a skip by exit code names its reason', () => {
    const { scheduler, logged } = wire();

    scheduler.emit('job-finished', { id: 'wa', exitCode: 2, job: JOB, skipped: true, durationMs: 300, trigger: { kind: 'manual' } });

    assert.equal(logged[0].event, 'job.skipped');
    assert.equal(logged[0].payload.reason, 'skipExitCodes');
    assert.equal(logged[0].payload.durationMs, 300);
    assert.equal(logged[0].payload.trigger, 'manual');
  });

  test('the scheduler really passes durationMs and the trigger on job-finished', async () => {
    const dir = tmp('orch-audit-sched-');
    const registry = new Registry(path.join(dir, 'registry.json'));
    const state    = new State(path.join(dir, 'state.json'));
    registry.load();
    registry.add({ id: 'j1', type: 'cron', schedule: '0 8 * * *', command: 'node -v', enabled: true, triggerMode: 'fire-and-forget' });
    const sched = new Scheduler(registry, state, {
      spawn: () => { const c = new EventEmitter(); c.pid = 1; setTimeout(() => c.emit('close', 0), 10); return c; },
      // The fake child claims pid 1, the root of every process on the machine: measuring it for real walked them all.
      sampleUsage: async () => null,
      liveness: async () => false,
      eventPublisher: { publish: () => {} },
      configDir: dir,
    });
    // A permanent listener, not once(): Scheduler keeps its event publisher in `_events`, the field
    // EventEmitter uses for its own listeners, and removing one can replace it.
    const seen = [];
    sched.on('job-finished', (ev) => seen.push(ev));

    await sched.trigger('j1', { kind: 'manual' }, true);

    assert.equal(seen.length, 1);
    assert.equal(typeof seen[0].durationMs, 'number');
    assert.equal(seen[0].trigger.kind, 'manual');
  });
});
