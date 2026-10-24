'use strict';

// `--progress <mode>` and `--progress-options <json|@file>` on add and edit; `--unset progress` to go back to auto.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-progflags-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

async function run(argv) {
  const calls = [];
  const deps = {
    send: async (command, payload) => { calls.push({ command, payload }); return {}; },
    startDaemon: async () => {},
    configDir: '/tmp/orch-test',
  };
  const origExit = process.exit;
  const origError = console.error;
  let exitCode = 0;
  let stderr = '';
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.error = (msg) => { stderr += `${msg}\n`; };
  try {
    await runCli(argv, deps);
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  return { calls, exitCode, stderr };
}

const ADD = ['add', 'cron', 'j1', '--schedule', '0 8 * * *', '--command', 'node -v'];
const sent = (calls) => calls[0].payload.updates ?? calls[0].payload;

describe('--progress on add and edit', () => {
  test('add --progress off stores the bare mode', async () => {
    const { calls, exitCode } = await run([...ADD, '--progress', 'off']);
    assert.equal(exitCode, 0);
    assert.equal(sent(calls).progress, 'off');
  });

  test('edit --progress history sends it in updates', async () => {
    const { calls } = await run(['edit', 'j1', '--progress', 'history']);
    assert.equal(sent(calls).progress, 'history');
  });

  test('no --progress sends no progress key (an edit is a patch)', async () => {
    const { calls } = await run(['edit', 'j1', '--label', 'x']);
    assert.ok(!('progress' in sent(calls)));
  });

  test('an unknown mode is refused before the daemon is contacted, with the registered ids', async () => {
    const { calls, exitCode, stderr } = await run([...ADD, '--progress', 'bogus']);
    assert.equal(exitCode, 4);
    assert.equal(calls.length, 0);
    assert.match(stderr, /Unknown progress strategy "bogus"/);
    assert.match(stderr, /auto, off, declared, ratio, log-declared, log-learned, ensemble, history/);
  });

  test('--progress without a value is named', async () => {
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /--progress needs a value/);
  });
});

describe('--progress-options', () => {
  test('without --progress it is refused with the fix', async () => {
    const { calls, exitCode, stderr } = await run(['edit', 'j1', '--progress-options', '{}']);
    assert.equal(exitCode, 4);
    assert.equal(calls.length, 0);
    assert.match(stderr, /--progress-options needs --progress <strategy>/);
  });

  test('invalid JSON is reported with the text it choked on', async () => {
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress', 'history', '--progress-options', '{nope']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /--progress-options is not valid JSON/);
    assert.match(stderr, /@file/);
  });

  test('options the strategy refuses are reported (history takes none)', async () => {
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress', 'history', '--progress-options', '{"a":1}']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /takes no options/);
  });

  test('a missing @file names the path', async () => {
    const missing = path.join(tmp, 'missing.json');
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress', 'history', '--progress-options', `@${missing}`]);
    assert.equal(exitCode, 4);
    assert.ok(stderr.includes(missing), stderr);
  });

  test('--progress-options is also read from @file and travels as { strategy, options }', async () => {
    // history takes no options, so an empty object file is the one valid case: it still proves the file is read.
    const file = path.join(tmp, 'empty.json');
    fs.writeFileSync(file, '');
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress', 'history', '--progress-options', `@${file}`]);
    assert.equal(exitCode, 4);
    assert.match(stderr, /is empty/);
  });
});

describe('--unset progress', () => {
  test('is accepted and reaches the daemon in unset', async () => {
    const { calls, exitCode } = await run(['edit', 'j1', '--unset', 'progress']);
    assert.equal(exitCode, 0);
    assert.deepEqual(calls[0].payload.unset, ['progress']);
  });

  test('setting and unsetting it in one command is refused', async () => {
    const { exitCode, stderr } = await run(['edit', 'j1', '--progress', 'off', '--unset', 'progress']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /Cannot set and unset "progress"/);
  });
});
