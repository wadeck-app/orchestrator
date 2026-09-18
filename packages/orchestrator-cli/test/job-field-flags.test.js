'use strict';

// `orch edit my-job --timeout 600` printed "Job updated.", exited 0, and changed nothing: the flag
// did not exist. Nine fields of Job had no flag at all -- timeoutSeconds, env, tags, onExitCode,
// alertAfterFailures, dependsOn, slaWindowMinutes, secrets, dryRunSupported -- and nothing looked at
// unrecognised flags, so every one of them was swallowed.
//
// The flags now come from one table shared by `add` and `edit`, so a field of Job cannot be settable
// by one and not the other, and an unknown flag is refused instead of ignored.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

function makeDeps() {
  const calls = [];
  return {
    calls,
    deps: {
      send: async (command, payload) => { calls.push({ command, payload }); return {}; },
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    },
  };
}

async function run(argv) {
  const { calls, deps } = makeDeps();
  const origExit = process.exit;
  const origError = console.error;
  let exitCode = 0;
  let stderr = '';
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.error = (msg) => { stderr += `${msg}\n`; };
  try {
    await runCli(argv, deps);
  } catch (e) {
    if (e.message !== 'exit') throw e;
  } finally {
    process.exit = origExit;
    console.error = origError;
  }
  return { calls, exitCode, stderr };
}

const ADD = ['add', 'cron', 'j1', '--schedule', '0 8 * * *', '--command', 'node -v'];

/** The `updates` object an edit sent, or the body an add sent. */
function sent(calls) {
  const payload = calls[0].payload;
  return payload.updates ?? payload;
}

describe('the fields that had no flag at all', () => {
  const cases = [
    { flag: '--timeout',              value: '600',          field: 'timeoutSeconds',     expected: 600 },
    { flag: '--alert-after-failures', value: '5',            field: 'alertAfterFailures', expected: 5 },
    { flag: '--sla-window',           value: '30',           field: 'slaWindowMinutes',   expected: 30 },
    { flag: '--depends-on',           value: 'other-job',    field: 'dependsOn',          expected: 'other-job' },
    { flag: '--tags',                 value: 'nightly,slow', field: 'tags',               expected: ['nightly', 'slow'] },
    { flag: '--secrets',              value: 'TOKEN,KEY',    field: 'secrets',            expected: ['TOKEN', 'KEY'] },
  ];

  for (const { flag, value, field, expected } of cases) {
    test(`edit ${flag} sets ${field}`, async () => {
      const { calls } = await run(['edit', 'j1', flag, value]);
      assert.equal(calls.length, 1, `nothing was sent for ${flag}`);
      assert.deepEqual(sent(calls)[field], expected);
    });

    test(`add ${flag} sets ${field}`, async () => {
      const { calls } = await run([...ADD, flag, value]);
      assert.deepEqual(sent(calls)[field], expected);
    });
  }

  test('--dry-run-supported is a presence flag', async () => {
    const { calls } = await run(['edit', 'j1', '--dry-run-supported']);
    assert.equal(sent(calls).dryRunSupported, true);
  });

  // Turning it off is `--unset`, like every other cleared option: a flag cannot carry "false"
  // without inventing a --no-* vocabulary the rest of the CLI does not have.
  test('--unset dryRunSupported turns it off', async () => {
    const { calls } = await run(['edit', 'j1', '--unset', 'dryRunSupported']);
    assert.deepEqual(calls[0].payload.unset, ['dryRunSupported']);
  });
});

describe('the key=value fields', () => {
  test('--env repeats into a map', async () => {
    const { calls } = await run(['edit', 'j1', '--env', 'TOKEN=abc', '--env', 'MODE=fast']);
    assert.deepEqual(sent(calls).env, { TOKEN: 'abc', MODE: 'fast' });
  });

  // A secret or a URL routinely contains '=' and ','; splitting on either would corrupt it.
  test('a value containing = and , survives intact', async () => {
    const { calls } = await run(['edit', 'j1', '--env', 'URL=https://x/?a=1,b=2']);
    assert.deepEqual(sent(calls).env, { URL: 'https://x/?a=1,b=2' });
  });

  test('--on-exit-code repeats into a map', async () => {
    const { calls } = await run(['edit', 'j1', '--on-exit-code', '2=already running', '--on-exit-code', '3=expired']);
    assert.deepEqual(sent(calls).onExitCode, { 2: 'already running', 3: 'expired' });
  });

  test('a pair with no = is refused, naming what was typed', async () => {
    const { exitCode, stderr, calls } = await run(['edit', 'j1', '--env', 'TOKEN']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /TOKEN/);
    assert.equal(calls.length, 0);
  });

  test('an empty key is refused', async () => {
    const { exitCode } = await run(['edit', 'j1', '--env', '=abc']);
    assert.equal(exitCode, 4);
  });
});

describe('a non-numeric value on a numeric flag is refused', () => {
  for (const flag of ['--timeout', '--alert-after-failures', '--sla-window']) {
    test(`${flag} rejects "soon"`, async () => {
      const { exitCode, stderr, calls } = await run(['edit', 'j1', flag, 'soon']);
      assert.equal(exitCode, 4, `${flag} accepted a non-number`);
      assert.match(stderr, /soon/, `the error does not quote what was typed: ${stderr}`);
      assert.equal(calls.length, 0);
    });
  }
});

// The old field loop mapped --liveness-port-file straight to a `livenessPortFile` key. That is not a
// field of Job -- the daemon reads liveness.portFile -- so using it without --liveness-strategy wrote
// a junk key into the registry and changed no liveness check.
describe('liveness flags only ever produce a liveness object', () => {
  test('--liveness-port-file alone does not invent a top-level field', async () => {
    const { calls, exitCode } = await run(['edit', 'j1', '--liveness-port-file', 'C:/tmp/x.port']);

    if (exitCode === 0) {
      const body = sent(calls);
      assert.ok(!('livenessPortFile' in body), `wrote a junk field: ${JSON.stringify(body)}`);
      assert.ok(!('liveness-port-file' in body));
    }
  });

  test('--liveness-port-file without a strategy is refused rather than ignored', async () => {
    const { exitCode, stderr, calls } = await run(['edit', 'j1', '--liveness-port-file', 'C:/tmp/x.port']);
    assert.equal(exitCode, 4, 'it was accepted and quietly did nothing');
    assert.match(stderr, /--liveness-strategy/, `the error does not say what is missing: ${stderr}`);
    assert.equal(calls.length, 0);
  });

  test('with a strategy it lands inside liveness', async () => {
    const { calls } = await run([
      'edit', 'j1', '--liveness-strategy', 'portFile', '--liveness-port-file', 'C:/tmp/x.port',
    ]);
    assert.deepEqual(sent(calls).liveness, { strategy: 'portFile', portFile: 'C:/tmp/x.port' });
  });
});

describe('an unknown flag is refused, not swallowed', () => {
  test('edit names the flag and exits 4', async () => {
    const { exitCode, stderr, calls } = await run(['edit', 'j1', '--timeoutt', '600']);
    assert.equal(exitCode, 4, 'a typo was accepted and silently did nothing');
    assert.match(stderr, /--timeoutt/);
    assert.equal(calls.length, 0, 'the daemon was asked to apply an edit the user did not get');
  });

  test('add names the flag and exits 4', async () => {
    const { exitCode, stderr } = await run([...ADD, '--timout', '600']);
    assert.equal(exitCode, 4);
    assert.match(stderr, /--timout/);
  });

  test('the error lists what is accepted', async () => {
    const { stderr } = await run(['edit', 'j1', '--nope', 'x']);
    assert.match(stderr, /--timeout/, `no list of valid flags to recover from: ${stderr}`);
  });

  // A value that happens to start with -- belongs to its flag, not to the unknown-flag check.
  // Not `--version` or `--pid`: cli.ts checks those against the whole argv before dispatching, so
  // they win over any command and can never be a value. Pre-existing, and left alone.
  test('a value starting with -- is not mistaken for a flag', async () => {
    const { calls, exitCode } = await run(['edit', 'j1', '--command', '--dry-run']);
    assert.equal(exitCode, 0, 'a legitimate command value was read as an unknown flag');
    assert.equal(sent(calls).command, '--dry-run');
  });

  test('the flags that were already accepted still are', async () => {
    const { exitCode } = await run([
      'edit', 'j1', '--label', 'L', '--cwd', 'C:/t', '--trigger-mode', 'wait',
      '--missed-firing', 'catch-up', '--skip-exit-codes', '2', '--unset', 'tags',
    ]);
    assert.equal(exitCode, 0);
  });

  test('add keeps its own vocabulary', async () => {
    const { exitCode } = await run(['add', 'startup', 'j2', '--command', 'node -v', '--delay', '30', '--disabled']);
    assert.equal(exitCode, 0);
  });

  test('--json stays usable on both', async () => {
    const e = await run(['edit', 'j1', '--label', 'L', '--json']);
    assert.equal(e.exitCode, 0);
    const a = await run([...ADD, '--json']);
    assert.equal(a.exitCode, 0);
  });
});
