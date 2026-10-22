'use strict';

// A job's `resourceLimits` tunes the resource monitor for that job: how far over its usual peaks it may
// go (factors of the baseline), for how long (sustainSeconds), absolute ceilings that need no baseline,
// and what happens on a sustained breach (kill | warn | off). Every refusal names the field, the bad
// value and the allowed range.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry, validateJob } = require('../src/registry');
const { State } = require('../src/state');
const {
  resourceLimitsError, resolveResourceLimits, RESOURCE_LIMIT_DEFAULTS,
} = require('../src/resource-limits');

const tmpDirs = [];

function makeEnv(job, audit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reslim-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'registry.json');
  const registry = new Registry(file);
  const state = new State(path.join(dir, 'state.json'));
  if (job) {
    registry.add(job);
  }
  const scheduler = {
    killJob: async () => ({ killed: false }), skipNextFiring: () => {},
    scheduleJob: () => {}, unscheduleJob: () => {},
  };
  return { commands: makeCommands(registry, state, scheduler, dir, undefined, audit), registry, dir, file };
}

function cronJob(extra = {}) {
  return { id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v', ...extra };
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('the defaults', () => {
  test('are 3x / 1.5x / 30 s / kill', () => {
    assert.deepEqual(RESOURCE_LIMIT_DEFAULTS, { enforce: 'kill', hardFactor: 3, softFactor: 1.5, sustainSeconds: 30 });
  });
});

describe('validation: every refusal names the field, the value and the range', () => {
  const bad = [
    ['not an object', 'high', /resourceLimits.*object.*"high"/s],
    ['an array', [1], /resourceLimits.*object/s],
    ['an unknown key', { hardFactr: 3 }, /resourceLimits\.hardFactr.*unknown.*enforce, hardFactor, softFactor, sustainSeconds, maxCpuPct, maxRamMb/is],
    ['enforce outside the list', { enforce: 'kil' }, /resourceLimits\.enforce.*kill, warn, off.*"kil"/s],
    ['hardFactor 1', { hardFactor: 1 }, /resourceLimits\.hardFactor.*greater than 1.*100.*\b1\b/s],
    ['hardFactor above 100', { hardFactor: 101 }, /resourceLimits\.hardFactor.*100.*101/s],
    ['hardFactor text', { hardFactor: 'x' }, /resourceLimits\.hardFactor.*"x"/s],
    ['hardFactor NaN', { hardFactor: NaN }, /resourceLimits\.hardFactor/],
    ['hardFactor Infinity', { hardFactor: Infinity }, /resourceLimits\.hardFactor/],
    ['softFactor 1', { softFactor: 1 }, /resourceLimits\.softFactor.*greater than 1/s],
    ['softFactor at the default hard', { softFactor: 3 }, /resourceLimits\.softFactor.*below.*hardFactor.*3/s],
    ['softFactor >= explicit hard', { softFactor: 2, hardFactor: 2 }, /resourceLimits\.softFactor.*below.*hardFactor.*2/s],
    ['hardFactor under the default soft', { hardFactor: 1.2 }, /resourceLimits\.hardFactor.*softFactor.*1\.5/s],
    ['sustain 1', { sustainSeconds: 1 }, /resourceLimits\.sustainSeconds.*2.*3600.*\b1\b/s],
    ['sustain 3601', { sustainSeconds: 3601 }, /resourceLimits\.sustainSeconds.*3601/s],
    ['sustain fractional', { sustainSeconds: 2.5 }, /resourceLimits\.sustainSeconds.*whole.*2\.5/s],
    ['maxCpuPct 0', { maxCpuPct: 0 }, /resourceLimits\.maxCpuPct.*greater than 0.*\b0\b/s],
    ['maxCpuPct negative', { maxCpuPct: -5 }, /resourceLimits\.maxCpuPct.*-5/s],
    ['maxRamMb 0', { maxRamMb: 0 }, /resourceLimits\.maxRamMb.*greater than 0/s],
    ['maxRamMb text', { maxRamMb: '512' }, /resourceLimits\.maxRamMb.*"512"/s],
  ];
  for (const [name, value, re] of bad) {
    test(name, () => {
      const msg = resourceLimitsError(value);
      assert.ok(msg, `accepted ${JSON.stringify(value)}`);
      assert.match(msg, re);
      assert.throws(() => validateJob(cronJob({ resourceLimits: value })), re);
    });
  }

  test('a full valid object is accepted', () => {
    const v = { enforce: 'warn', hardFactor: 4, softFactor: 2, sustainSeconds: 60, maxCpuPct: 150, maxRamMb: 2048 };
    assert.equal(resourceLimitsError(v), null);
    validateJob(cronJob({ resourceLimits: v }));
  });

  test('the bounds are inclusive where stated', () => {
    assert.equal(resourceLimitsError({ hardFactor: 100, softFactor: 99 }), null);
    assert.equal(resourceLimitsError({ sustainSeconds: 2 }), null);
    assert.equal(resourceLimitsError({ sustainSeconds: 3600 }), null);
    assert.equal(resourceLimitsError({ softFactor: 1.01, hardFactor: 1.02 }), null);
  });
});

describe('resolveResourceLimits', () => {
  const base = { cpuPct: 10, ramMb: 100 };

  test('defaults on a baseline: 1.5x soft, 3x hard, 30 s of 2 s samples = 15', () => {
    const r = resolveResourceLimits(undefined, base, 2000);
    assert.deepEqual(r, {
      enforce: 'kill', sustainSamples: 15,
      soft: { cpuPct: 15, ramMb: 150 }, hard: { cpuPct: 30, ramMb: 300 },
    });
  });

  test('no baseline and no ceilings: no thresholds', () => {
    const r = resolveResourceLimits({ hardFactor: 5 }, null, 2000);
    assert.equal(r.soft, null);
    assert.equal(r.hard, null);
  });

  test('absolute ceilings exist without a baseline, per resource', () => {
    const r = resolveResourceLimits({ maxRamMb: 512 }, null, 2000);
    assert.deepEqual(r.hard, { cpuPct: null, ramMb: 512 });
    assert.equal(r.soft, null);
  });

  test('a ceiling replaces the factor-derived threshold of that resource only', () => {
    const r = resolveResourceLimits({ maxCpuPct: 90, hardFactor: 4 }, base, 2000);
    assert.deepEqual(r.hard, { cpuPct: 90, ramMb: 400 });
  });

  test('sustain samples round up, at least 1', () => {
    assert.equal(resolveResourceLimits({ sustainSeconds: 5 }, null, 2000).sustainSamples, 3);
    assert.equal(resolveResourceLimits({ sustainSeconds: 2 }, null, 5000).sustainSamples, 1);
    assert.equal(resolveResourceLimits({ sustainSeconds: 60 }, null, 2000).sustainSamples, 30);
  });

  test('enforce is carried', () => {
    assert.equal(resolveResourceLimits({ enforce: 'off' }, base, 2000).enforce, 'off');
  });
});

describe('stored, edited, unset', () => {
  test('add stores it as given and get-job returns it', () => {
    const limits = { enforce: 'warn', hardFactor: 4 };
    const { registry, commands, file } = makeEnv(cronJob({ resourceLimits: limits }));
    assert.deepEqual(registry.get('j1').resourceLimits, limits);
    assert.deepEqual(commands['get-job']({ id: 'j1' }).resourceLimits, limits);
    assert.deepEqual(commands['list-jobs']()[0].resourceLimits, limits);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0].resourceLimits, limits);
  });

  test('an empty object is not stored', () => {
    const { registry } = makeEnv(cronJob({ resourceLimits: {} }));
    assert.ok(!('resourceLimits' in registry.get('j1')));
  });

  test('add refuses a bad value and stores nothing', () => {
    const { registry } = makeEnv();
    assert.throws(() => registry.add(cronJob({ resourceLimits: { hardFactor: 0.5 } })), /resourceLimits\.hardFactor/);
    assert.equal(registry.list().length, 0);
  });

  test('edit replaces the whole object and validates it', () => {
    const { commands, registry } = makeEnv(cronJob({ resourceLimits: { hardFactor: 4 } }));
    commands['edit-job']({ id: 'j1', updates: { resourceLimits: { enforce: 'off' } } });
    assert.deepEqual(registry.get('j1').resourceLimits, { enforce: 'off' });
    assert.throws(
      () => commands['edit-job']({ id: 'j1', updates: { resourceLimits: { sustainSeconds: 1 } } }),
      /resourceLimits\.sustainSeconds/,
    );
    assert.deepEqual(registry.get('j1').resourceLimits, { enforce: 'off' });
  });

  test('edit --unset resourceLimits drops the key', () => {
    const { commands, registry } = makeEnv(cronJob({ resourceLimits: { hardFactor: 4 } }));
    commands['edit-job']({ id: 'j1', unset: ['resourceLimits'] });
    assert.ok(!('resourceLimits' in registry.get('j1')));
  });

  test('the audit line names the field, never its content', () => {
    const logged = [];
    const { commands } = makeEnv(cronJob(), { log: (event, data) => logged.push({ event, data }) });
    commands['edit-job']({ id: 'j1', updates: { resourceLimits: { maxRamMb: 777 } } });
    const edited = logged.find(l => l.event === 'job.edited');
    assert.deepEqual(edited.data.changes, ['resourceLimits']);
    assert.ok(!JSON.stringify(edited).includes('777'));
  });
});
