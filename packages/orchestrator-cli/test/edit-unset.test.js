'use strict';

// `orch edit` is a patch: an absent flag means "leave this field alone". That makes an already-set
// option unremovable through a value -- there is nothing to type that means "no working directory".
// Hence `--unset <field>`, which reaches the daemon as a separate `unset` list next to `updates`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];

function makeEnv(job) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-unset-'));
  tmpDirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.add(job);
  const scheduler = { killJob: async () => ({ killed: false }), skipNextFiring: () => {} };
  return { commands: makeCommands(registry, state, scheduler, dir), registry, dir };
}

function cronJob(extra = {}) {
  return {
    id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v',
    label: 'Nightly', cwd: 'C:/tmp', ...extra,
  };
}

after(() => {
  for (const dir of tmpDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('registry.edit unsets a field', () => {
  test('cwd loses its key entirely, not a null or an empty string', () => {
    const { registry } = makeEnv(cronJob());
    assert.equal(registry.get('j1').cwd, 'C:/tmp', 'fixture did not set cwd');

    registry.edit('j1', {}, ['cwd']);

    const job = registry.get('j1');
    assert.ok(!('cwd' in job), `cwd survived as ${JSON.stringify(job.cwd)}`);
  });

  test('the cleared field is gone from the file too, not just from memory', () => {
    const { registry, dir } = makeEnv(cronJob());

    registry.edit('j1', {}, ['cwd']);

    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
    assert.ok(!('cwd' in raw.jobs[0]), 'the key is still on disk, so a restart brings it back');
  });

  test('unrelated fields are untouched', () => {
    const { registry } = makeEnv(cronJob());

    registry.edit('j1', {}, ['cwd']);

    const job = registry.get('j1');
    assert.equal(job.command, 'node -v');
    assert.equal(job.schedule, '0 9 * * *');
    assert.equal(job.label, 'Nightly');
    assert.equal(job.enabled, true);
  });

  test('several fields clear in one call', () => {
    const { registry } = makeEnv(cronJob({ timeoutSeconds: 30, tags: ['a'] }));

    registry.edit('j1', {}, ['cwd', 'timeoutSeconds', 'tags']);

    const job = registry.get('j1');
    assert.ok(!('cwd' in job) && !('timeoutSeconds' in job) && !('tags' in job),
      `something survived: ${JSON.stringify(job)}`);
  });

  test('clearing a field that was never set is a no-op, not an error', () => {
    const { registry } = makeEnv(cronJob({ cwd: undefined }));

    registry.edit('j1', {}, ['timeoutSeconds']);

    assert.ok(!('timeoutSeconds' in registry.get('j1')));
  });

  test('an update and an unset ride along in the same call', () => {
    const { registry } = makeEnv(cronJob());

    registry.edit('j1', { command: 'node --version' }, ['cwd']);

    const job = registry.get('j1');
    assert.equal(job.command, 'node --version');
    assert.ok(!('cwd' in job));
  });
});

// label, triggerMode and liveness are non-optional in the Job type the dashboard consumes: dropping
// the key would hand orch-ui a job that does not match its own types. They go back to the value
// `orch add` would have given them.
describe('registry.edit resets the fields that cannot simply disappear', () => {
  test('label falls back to the job id, like at creation', () => {
    const { registry } = makeEnv(cronJob());

    registry.edit('j1', {}, ['label']);

    assert.equal(registry.get('j1').label, 'j1');
  });

  test('triggerMode goes back to fire-and-forget', () => {
    const { registry } = makeEnv(cronJob({ triggerMode: 'wait' }));

    registry.edit('j1', {}, ['triggerMode']);

    assert.equal(registry.get('j1').triggerMode, 'fire-and-forget');
  });

});

describe('registry.edit clears a liveness check by removing it', () => {
  // liveness is optional in Job and every reader tests it for truthiness, so there is no reason to
  // keep a null around -- unlike label and triggerMode above.
  test('the key is gone, not set to null', () => {
    const { registry } = makeEnv(cronJob({ liveness: { strategy: 'command', command: 'tasklist' } }));

    registry.edit('j1', {}, ['liveness']);

    const job = registry.get('j1');
    assert.ok(!('liveness' in job), `liveness survived as ${JSON.stringify(job.liveness)}`);
  });
});

// Pinned as a whole, not field by field, because the rule is what matters: every OPTIONAL field of
// Job is clearable, only the required ones are not. A field added to Job and forgotten here is a
// field the dashboard and the CLI cannot clear -- which is the bug this feature exists to fix, one
// field at a time. This list failing is the reminder to decide, not a nuisance to update blindly.
describe('the set of clearable fields matches the optional fields of Job', () => {
  test('every optional Job field is clearable, and nothing required is', () => {
    const { UNSETTABLE_FIELDS } = require('../src/types');

    assert.deepEqual(Object.keys(UNSETTABLE_FIELDS).sort(), [
      'alertAfterFailures', 'cwd', 'delaySeconds', 'dependsOn', 'dryRunSupported', 'env', 'label',
      'liveness', 'missedFiring', 'onExitCode', 'retryDelays', 'retryOnExitCodes', 'secrets',
      'skipExitCodes', 'slaWindowMinutes', 'tags', 'timeoutSeconds', 'triggerMode',
    ]);
  });

  for (const field of ['id', 'type', 'command', 'enabled', 'schedule', 'delayMs', 'scheduledAt']) {
    test(`${field} is required and stays unclearable`, () => {
      const { UNSETTABLE_FIELDS } = require('../src/types');

      assert.ok(!(field in UNSETTABLE_FIELDS), `${field} became clearable; the scheduler needs it`);
    });
  }
});

describe('registry.edit refuses a field it must not clear', () => {
  for (const field of ['command', 'schedule', 'type', 'id', 'enabled']) {
    test(`${field} is required, and the error says so and lists what is allowed`, () => {
      const { registry } = makeEnv(cronJob());

      assert.throws(
        () => registry.edit('j1', {}, [field]),
        (err) => {
          assert.match(err.message, new RegExp(field), `the error does not name the field: ${err.message}`);
          assert.match(err.message, /required/i, `the error does not say why: ${err.message}`);
          assert.match(err.message, /cwd/, `the error does not list the unsettable fields: ${err.message}`);
          return true;
        },
      );
    });
  }

  test('a field nobody knows is named as unknown, with the valid list', () => {
    const { registry } = makeEnv(cronJob());

    assert.throws(() => registry.edit('j1', {}, ['workdir']), (err) => {
      assert.match(err.message, /workdir/);
      assert.match(err.message, /unknown/i);
      assert.match(err.message, /cwd/, `no suggestion of the real names: ${err.message}`);
      return true;
    });
  });

  test('setting and clearing the same field in one call is a contradiction, not a coin flip', () => {
    const { registry } = makeEnv(cronJob());

    assert.throws(() => registry.edit('j1', { cwd: 'C:/other' }, ['cwd']), /cwd/);
  });

  test('a refused unset writes nothing at all', () => {
    const { registry } = makeEnv(cronJob());

    assert.throws(() => registry.edit('j1', { label: 'Renamed' }, ['command']));

    const job = registry.get('j1');
    assert.equal(job.label, 'Nightly', 'the accompanying update was applied despite the refusal');
    assert.equal(job.cwd, 'C:/tmp');
  });
});

describe('edit-job carries unset over the RPC boundary', () => {
  test('the documented payload shape clears the field', () => {
    const { commands, registry } = makeEnv(cronJob());

    const result = commands['edit-job']({ id: 'j1', updates: {}, unset: ['cwd'] });

    assert.ok(!('cwd' in result), `the returned job still has cwd: ${JSON.stringify(result.cwd)}`);
    assert.ok(!('cwd' in registry.get('j1')), 'the clear never reached the registry');
  });

  test('unset alone is enough -- updates may be omitted', () => {
    const { commands, registry } = makeEnv(cronJob());

    commands['edit-job']({ id: 'j1', unset: ['cwd'] });

    assert.ok(!('cwd' in registry.get('j1')));
  });

  test('a non-array unset is named, rather than silently ignored', () => {
    const { commands, registry } = makeEnv(cronJob());

    assert.throws(() => commands['edit-job']({ id: 'j1', updates: {}, unset: 'cwd' }), /unset/);
    assert.equal(registry.get('j1').cwd, 'C:/tmp', 'a rejected payload still wrote');
  });

  test('a non-string entry in unset is named', () => {
    const { commands } = makeEnv(cronJob());

    assert.throws(() => commands['edit-job']({ id: 'j1', unset: [42] }), /unset/);
  });

  test('a plain edit with neither updates nor unset is still refused', () => {
    const { commands } = makeEnv(cronJob());

    assert.throws(() => commands['edit-job']({ id: 'j1' }), /updates/);
  });
});
