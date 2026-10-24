'use strict';

// The per-job `progress` key: 'auto' (default) | 'off' | '<strategy id>' | { strategy, options }.
// Validated at config time (registry.validateJob) with the registered ids in the error, clearable with
// --unset, shown by the audit by NAME only, and honoured by the engine (off = a reasoned "no estimate",
// an explicit id never falls back to another strategy).
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry, validateJob } = require('../src/registry');
const { State } = require('../src/state');
const { UNSETTABLE_FIELDS } = require('../src/types');
const { estimate: estimateProgress } = require('./helpers/progress-fixtures');
const { PROGRESS_STRATEGY_IDS, progressSettingError, resolveProgressSetting } = require('../src/progress/setting');
const { T0, open, usable, job } = require('./helpers/progress-fixtures');

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeEnv(initial, audit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-progset-'));
  tmpDirs.push(dir);
  const file = path.join(dir, 'registry.json');
  const registry = new Registry(file);
  const state = new State(path.join(dir, 'state.json'));
  if (initial) {
    registry.add(initial);
  }
  const scheduler = {
    killJob: async () => ({ killed: false }), skipNextFiring: () => {},
    scheduleJob: () => {}, unscheduleJob: () => {},
  };
  return { commands: makeCommands(registry, state, scheduler, dir, undefined, audit), registry, file };
}

const cron = (extra = {}) => ({ id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v', ...extra });

// A strategy that takes options, since the only registered one takes none.
const withOptions = {
  id: 'opt', version: 1,
  validateOptions: (raw) => (raw && typeof raw === 'object' && typeof raw.pattern === 'string'
    ? { ok: true, value: raw } : { ok: false, error: 'options.pattern must be a string' }),
  estimate: () => { throw new Error('not used'); },
};

describe('the registered ids live in one constant', () => {
  test('PROGRESS_STRATEGY_IDS lists what the engine can run', () => {
    assert.ok(PROGRESS_STRATEGY_IDS.includes('history'));
    const { STRATEGIES } = require('../src/progress/engine');
    assert.deepEqual([...PROGRESS_STRATEGY_IDS], STRATEGIES.map((s) => s.id));
  });
});

describe('progressSettingError', () => {
  test('accepts auto, off and a registered id', () => {
    for (const ok of ['auto', 'off', 'history']) {
      assert.equal(progressSettingError(ok), null, ok);
    }
  });

  test('accepts the object form with a registered id and valid options', () => {
    assert.equal(progressSettingError({ strategy: 'opt', options: { pattern: 'x' } }, [withOptions]), null);
  });

  test('an unknown id is refused and the registered ids are listed', () => {
    const msg = progressSettingError('nope');
    assert.match(msg, /Unknown progress strategy "nope"/);
    assert.match(msg, /auto, off, declared, ratio, log-declared, log-learned, ensemble, history/);
  });

  test('options the strategy refuses are reported with the strategy id and its reason', () => {
    const msg = progressSettingError({ strategy: 'opt', options: { pattern: 3 } }, [withOptions]);
    assert.match(msg, /progress options for "opt"/);
    assert.match(msg, /options\.pattern must be a string/);
  });

  test('a strategy that takes no options refuses them', () => {
    assert.match(progressSettingError({ strategy: 'history', options: { a: 1 } }), /takes no options/);
  });

  test('auto and off take no options', () => {
    assert.match(progressSettingError({ strategy: 'off', options: {} }), /"off" takes no options/);
    assert.match(progressSettingError({ strategy: 'auto', options: { a: 1 } }), /"auto" takes no options/);
  });

  test('wrong shapes are refused with what is accepted', () => {
    for (const bad of [42, true, [], { options: {} }, { strategy: 3 }, { strategy: 'history', extra: 1 }, '']) {
      const msg = progressSettingError(bad);
      assert.match(msg, /progress must be/, JSON.stringify(bad));
    }
  });

  test('oversized options are refused', () => {
    const msg = progressSettingError({ strategy: 'opt', options: { pattern: 'x'.repeat(20_000) } }, [withOptions]);
    assert.match(msg, /too large/);
  });
});

describe('resolveProgressSetting', () => {
  test('absent is auto', () => {
    assert.deepEqual(resolveProgressSetting(undefined), { kind: 'auto' });
    assert.deepEqual(resolveProgressSetting('auto'), { kind: 'auto' });
    assert.deepEqual(resolveProgressSetting({ strategy: 'auto' }), { kind: 'auto' });
  });
  test('off, a bare id and the object form', () => {
    assert.deepEqual(resolveProgressSetting('off'), { kind: 'off' });
    assert.deepEqual(resolveProgressSetting('history'), { kind: 'strategy', id: 'history', options: undefined });
    assert.deepEqual(resolveProgressSetting({ strategy: 'x', options: { a: 1 } }), { kind: 'strategy', id: 'x', options: { a: 1 } });
  });
});

describe('validateJob and the registry', () => {
  test('validateJob refuses a bad progress with the registered ids', () => {
    assert.throws(() => validateJob(cron({ progress: 'bogus' })), /Unknown progress strategy "bogus".*history/);
  });

  test('registry.add stores a valid progress as given', () => {
    const { registry } = makeEnv(cron({ progress: 'history' }));
    assert.equal(registry.get('j1').progress, 'history');
  });

  test('registry.add refuses an unknown one and writes nothing', () => {
    const { registry } = makeEnv();
    assert.throws(() => registry.add(cron({ progress: 'bogus' })), /Unknown progress strategy/);
    assert.ok(!registry.get('j1'));
  });

  test('registry.edit refuses an unknown one and keeps the old value', () => {
    const { registry } = makeEnv(cron({ progress: 'off' }));
    assert.throws(() => registry.edit('j1', { progress: 'bogus' }), /Unknown progress strategy/);
    assert.equal(registry.get('j1').progress, 'off');
  });

  test('progress is clearable: --unset drops the key, which means auto', () => {
    assert.equal(UNSETTABLE_FIELDS.progress, 'delete');
    const { registry, file } = makeEnv(cron({ progress: 'off' }));
    registry.edit('j1', {}, ['progress']);
    assert.ok(!('progress' in registry.get('j1')));
    assert.ok(!('progress' in JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0]));
  });

  test('an empty value is the same as none', () => {
    const { registry } = makeEnv(cron({ progress: 'off' }));
    registry.edit('j1', { progress: '' });
    assert.ok(!('progress' in registry.get('j1')));
  });

  test('get-job and list-jobs carry the field', () => {
    const { commands } = makeEnv(cron({ progress: 'off' }));
    assert.equal(commands['get-job']({ id: 'j1' }).progress, 'off');
    assert.equal(commands['list-jobs']({}).find((j) => j.id === 'j1').progress, 'off');
  });
});

describe('the audit names the field and not the options', () => {
  test('job.edited lists progress among the changes without its options', () => {
    const events = [];
    const audit = { log: (event, data) => events.push({ event, data }) };
    const { commands } = makeEnv(cron(), audit);

    commands['edit-job']({ id: 'j1', updates: { progress: { strategy: 'history' } } });

    const edited = events.find((e) => e.event === 'job.edited');
    assert.ok(edited.data.changes.includes('progress'));
  });

  test('job.added does not log the setting either', () => {
    const events = [];
    const audit = { log: (event, data) => events.push({ event, data }) };
    const { commands } = makeEnv(null, audit);
    commands['add-job'](cron({ progress: 'history' }));
    assert.ok(!JSON.stringify(events).includes('"history"'));
  });
});

describe('the engine honours job.progress', () => {
  const now = () => new Date(T0);
  const history = { j: [open(T0, 60), ...usable(5, 600)] };

  test('off: a reasoned no-estimate that says how to turn it on', () => {
    const r = estimateProgress({ jobs: [job({ progress: 'off' })], history, now });
    assert.equal(r.j.progress, null);
    assert.equal(r.j.confidence, 'none');
    assert.equal(r.j.strategyId, null);
    assert.match(r.j.reason, /progress is off for this job \(orch edit j --progress auto to enable\)/);
  });

  test('an explicit id runs that strategy only, with no auto prefix', () => {
    const r = estimateProgress({ jobs: [job({ progress: 'history' })], history, now });
    assert.equal(r.j.strategyId, 'history');
    assert.equal(r.j.progress, 0.1);
    assert.ok(!r.j.reason.startsWith('auto:'), r.j.reason);
  });

  test('an explicit id never falls back: its own reason is shown, the other strategies are not asked', () => {
    let asked = 0;
    const mk = (id, confidence) => ({
      id, version: 1, validateOptions: () => ({ ok: true, value: undefined }),
      estimate: (ctx) => {
        asked++;
        return { strategyId: id, progress: confidence === 'none' ? null : 0.5, etaAt: null, confidence, confidenceScore: 0,
          reason: `${id} says ${confidence}`, serverNow: ctx.now().toISOString() };
      },
    });
    const r = estimateProgress({
      jobs: [job({ progress: 'a' })], history, now,
      strategies: () => [mk('b', 'high'), mk('a', 'none')],
    });
    assert.equal(r.j.progress, null);
    assert.equal(r.j.strategyId, 'a');
    assert.equal(r.j.reason, 'a says none');
    assert.equal(asked, 1);
  });

  test('the validated options reach the strategy', () => {
    let seen;
    const s = {
      id: 'opt', version: 1, validateOptions: (raw) => ({ ok: true, value: { ...raw, normalised: true } }),
      estimate: (ctx) => { seen = ctx.options; return { strategyId: 'opt', progress: 0.5, etaAt: null, confidence: 'low', confidenceScore: 0.1, reason: 'r', serverNow: ctx.now().toISOString() }; },
    };
    estimateProgress({ jobs: [job({ progress: { strategy: 'opt', options: { a: 1 } } })], history, now, strategies: () => [s] });
    assert.deepEqual(seen, { a: 1, normalised: true });
  });

  test('a stored strategy this daemon does not know gives a reason with the fix, not a crash', () => {
    const r = estimateProgress({ jobs: [job({ progress: 'gone' })], history, now });
    assert.equal(r.j.progress, null);
    assert.match(r.j.reason, /"gone".*not registered.*history.*orch edit j --progress auto/);
  });

  test('stored options that no longer validate give a reason, not a crash', () => {
    const r = estimateProgress({ jobs: [job({ progress: { strategy: 'history', options: { a: 1 } } })], history, now });
    assert.equal(r.j.progress, null);
    assert.match(r.j.reason, /takes no options.*orch edit j/);
  });

  test('auto and an absent key behave the same', () => {
    const a = estimateProgress({ jobs: [job({ progress: 'auto' })], history, now });
    const b = estimateProgress({ jobs: [job()], history, now });
    assert.deepEqual(a, b);
  });
});
