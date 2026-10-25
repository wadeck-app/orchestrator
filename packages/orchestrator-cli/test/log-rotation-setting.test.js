'use strict';

// The `logRotation` job setting end to end up to the daemon boundary: the registry (add, edit, --unset, validation), the
// config.yml keys that give the daemon-wide default, and the `orch add` / `orch edit` flags --log-max-size and --log-keep.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Registry } = require('../src/registry');
const { loadDaemonConfig } = require('../src/daemonConfig');
const { runCli } = require('../src/cli');
const { UNSETTABLE_FIELDS } = require('../src/types');

let dir;
let registry;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logrot-setting-'));
  registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const job = (extra = {}) => ({ id: 'web', type: 'startup', command: 'node server.js', timeoutSeconds: 0, ...extra });

describe('registry', () => {
  test('add stores the setting as given, on disk too', () => {
    registry.add(job({ logRotation: { maxSizeMb: 20, keepSegments: 3 } }));
    assert.deepEqual(registry.get('web').logRotation, { maxSizeMb: 20, keepSegments: 3 });
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'registry.json'), 'utf8'));
    assert.deepEqual(onDisk.jobs[0].logRotation, { maxSizeMb: 20, keepSegments: 3 });
  });

  test('a job without it has none: the daemon-wide values apply', () => {
    registry.add(job());
    assert.equal('logRotation' in registry.get('web'), false);
  });

  const refused = [
    ['an empty object', {}, /logRotation is empty/],
    ['a string', 'big', /logRotation must be an object/],
    ['an unknown key', { size: 5 }, /unknown key "size".*maxSizeMb, keepSegments/],
    ['a negative size', { maxSizeMb: -3 }, /logRotation\.maxSizeMb must not be negative/],
    ['a size below the minimum', { maxSizeMb: 0.0001 }, /logRotation\.maxSizeMb must be at least 0\.001/],
    ['zero segments', { keepSegments: 0 }, /logRotation\.keepSegments must be a whole number from 1 to 1000 \(got: 0\)/],
    ['a fractional count', { keepSegments: 2.5 }, /logRotation\.keepSegments must be a whole number/],
  ];
  for (const [what, value, pattern] of refused) {
    test(`add refuses ${what}, and stores nothing`, () => {
      assert.throws(() => registry.add(job({ logRotation: value })), pattern);
      assert.equal(registry.get('web'), null);
    });
  }

  test('edit replaces the setting and refuses a bad one without touching the job', () => {
    registry.add(job({ logRotation: { maxSizeMb: 20 } }));
    registry.edit('web', { logRotation: { maxSizeMb: 20, keepSegments: 9 } });
    assert.deepEqual(registry.get('web').logRotation, { maxSizeMb: 20, keepSegments: 9 });
    assert.throws(() => registry.edit('web', { logRotation: { keepSegments: 0 } }), /logRotation\.keepSegments/);
    assert.deepEqual(registry.get('web').logRotation, { maxSizeMb: 20, keepSegments: 9 });
  });

  test('--unset logRotation goes back to the daemon-wide values', () => {
    registry.add(job({ logRotation: { maxSizeMb: 20 } }));
    registry.edit('web', {}, ['logRotation']);
    assert.equal('logRotation' in registry.get('web'), false);
    assert.ok('logRotation' in UNSETTABLE_FIELDS);
  });
});

describe('config.yml', () => {
  function config(text) {
    fs.writeFileSync(path.join(dir, 'config.yml'), text);
    const warnings = [];
    return { config: loadDaemonConfig(dir, (m) => warnings.push(m)), warnings };
  }

  test('defaults: 50 MB, 5 segments, nothing said', () => {
    const { config: c, warnings } = config('autoUpdate: true\n');
    assert.equal(c.logMaxSizeMb, 50);
    assert.equal(c.logKeepSegments, 5);
    assert.deepEqual(warnings, []);
  });

  test('both keys are read', () => {
    const { config: c, warnings } = config('logMaxSizeMb: 10\nlogKeepSegments: 8  # a week of it\n');
    assert.equal(c.logMaxSizeMb, 10);
    assert.equal(c.logKeepSegments, 8);
    assert.deepEqual(warnings, []);
  });

  test('logMaxSizeMb: 0 turns the rotation off for every job without a setting of its own', () => {
    const { config: c, warnings } = config('logMaxSizeMb: 0\n');
    assert.equal(c.logMaxSizeMb, 0);
    assert.deepEqual(warnings, []);
  });

  test('logKeepSegments: 0 is refused with a warning that names the default used', () => {
    const { config: c, warnings } = config('logKeepSegments: 0\n');
    assert.equal(c.logKeepSegments, 5);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /config\.yml line 1: logKeepSegments must be a whole number from 1 to 1000.*"0".*using 5/);
  });

  test('logKeepSegments above 1000 is refused', () => {
    const { config: c, warnings } = config('logKeepSegments: 5000\n');
    assert.equal(c.logKeepSegments, 5);
    assert.match(warnings[0], /logKeepSegments must be a whole number from 1 to 1000.*"5000"/);
  });

  test('logMaxSizeMb that is not a whole number gets the usual warning', () => {
    const { config: c, warnings } = config('logMaxSizeMb: 1.5\n');
    assert.equal(c.logMaxSizeMb, 50);
    assert.match(warnings[0], /logMaxSizeMb must be a non-negative whole number.*"1.5".*using 50/);
  });

  test('logMaxSizeMb above 10240 is refused', () => {
    const { config: c, warnings } = config('logMaxSizeMb: 99999\n');
    assert.equal(c.logMaxSizeMb, 50);
    assert.match(warnings[0], /logMaxSizeMb must be at most 10240.*"99999".*using 50/);
  });
});

async function run(argv, jobs = {}) {
  const calls = [];
  const deps = {
    send: async (command, payload) => {
      calls.push({ command, payload });
      return command === 'get-job' ? (jobs[payload.id] ?? null) : {};
    },
    startDaemon: async () => {},
    configDir: '/tmp/orch-test',
  };
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let exitCode = 0;
  let stderr = '';
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.error = (msg) => { stderr += `${msg}\n`; };
  console.log = () => {};
  try {
    await runCli(argv, deps);
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
  return { calls, exitCode, stderr };
}

const ADD = ['add', 'startup', 'web', '--command', 'node server.js', '--timeout', '0'];
const sentJob = (calls) => calls.find((c) => c.command === 'add-job').payload;
const sentEdit = (calls) => calls.find((c) => c.command === 'edit-job').payload;

describe('orch add', () => {
  test('--log-max-size and --log-keep build logRotation', async () => {
    const { calls, exitCode } = await run([...ADD, '--log-max-size', '20', '--log-keep', '3']);
    assert.equal(exitCode, 0);
    assert.deepEqual(sentJob(calls).logRotation, { maxSizeMb: 20, keepSegments: 3 });
  });

  test('either flag alone sets only its key; decimals are accepted for the size', async () => {
    assert.deepEqual(sentJob((await run([...ADD, '--log-max-size', '0.5'])).calls).logRotation, { maxSizeMb: 0.5 });
    assert.deepEqual(sentJob((await run([...ADD, '--log-keep', '2'])).calls).logRotation, { keepSegments: 2 });
  });

  test('--log-max-size 0 turns the rotation off for the job', async () => {
    assert.deepEqual(sentJob((await run([...ADD, '--log-max-size', '0'])).calls).logRotation, { maxSizeMb: 0 });
  });

  test('without the flags nothing about rotation is sent', async () => {
    assert.equal('logRotation' in sentJob((await run(ADD)).calls), false);
  });

  const refused = [
    ['a size that is not a number', ['--log-max-size', 'big'], /--log-max-size expects a number of megabytes \(0 turns the rotation off\), but got "big"/],
    ['a size with no value', ['--log-max-size'], /--log-max-size needs a value/],
    ['a negative size', ['--log-max-size', '-2'], /logRotation\.maxSizeMb must not be negative \(got: -2\).*\(flag: --log-max-size\)/s],
    ['a size below the minimum', ['--log-max-size', '0.0001'], /logRotation\.maxSizeMb must be at least 0\.001.*\(flag: --log-max-size\)/s],
    ['a count that is not a number', ['--log-keep', 'many'], /--log-keep expects a whole number of segments, but got "many"/],
    ['zero segments', ['--log-keep', '0'], /logRotation\.keepSegments must be a whole number from 1 to 1000 \(got: 0\).*\(flag: --log-keep\)/s],
    ['a fractional count', ['--log-keep', '2.5'], /logRotation\.keepSegments must be a whole number.*\(flag: --log-keep\)/s],
  ];
  for (const [what, flags, pattern] of refused) {
    test(`refuses ${what} before anything is sent, exit 4`, async () => {
      const { calls, exitCode, stderr } = await run([...ADD, ...flags]);
      assert.equal(exitCode, 4);
      assert.match(stderr, pattern);
      assert.equal(calls.some((c) => c.command === 'add-job'), false);
    });
  }
});

describe('orch edit', () => {
  const plain = { id: 'web' };
  const tuned = { id: 'web', logRotation: { maxSizeMb: 20, keepSegments: 3 } };

  test('an edit changes only the key given and keeps the other one', async () => {
    const { calls } = await run(['edit', 'web', '--log-keep', '9'], { web: tuned });
    assert.deepEqual(sentEdit(calls).updates.logRotation, { maxSizeMb: 20, keepSegments: 9 });
  });

  test('on a job without a setting, only the given key is stored (the rest stays the daemon-wide value)', async () => {
    const { calls } = await run(['edit', 'web', '--log-max-size', '5'], { web: plain });
    assert.deepEqual(sentEdit(calls).updates.logRotation, { maxSizeMb: 5 });
  });

  test('an unknown job is reported like everywhere else', async () => {
    const { exitCode, stderr } = await run(['edit', 'ghost', '--log-keep', '2'], {});
    assert.equal(exitCode, 3);
    assert.match(stderr, /Job not found: "ghost"/);
  });

  test('a bad value is refused with the flag, before the edit is sent', async () => {
    const { calls, exitCode, stderr } = await run(['edit', 'web', '--log-keep', '0'], { web: tuned });
    assert.equal(exitCode, 4);
    assert.match(stderr, /logRotation\.keepSegments.*\(flag: --log-keep\)/s);
    assert.equal(calls.some((c) => c.command === 'edit-job'), false);
  });

  test('--unset logRotation clears it', async () => {
    const { calls, exitCode } = await run(['edit', 'web', '--unset', 'logRotation']);
    assert.equal(exitCode, 0);
    assert.deepEqual(sentEdit(calls).unset, ['logRotation']);
  });

  test('setting and clearing it in one command is refused, saying which to drop', async () => {
    const { exitCode, stderr } = await run(['edit', 'web', '--log-keep', '2', '--unset', 'logRotation'], { web: tuned });
    assert.equal(exitCode, 4);
    assert.match(stderr, /logRotation/);
  });

  test('an edit that does not mention rotation does not fetch or send anything about it', async () => {
    const { calls } = await run(['edit', 'web', '--label', 'Web']);
    assert.deepEqual(calls.map((c) => c.command), ['edit-job']);
    assert.equal('logRotation' in sentEdit(calls).updates, false);
  });
});
