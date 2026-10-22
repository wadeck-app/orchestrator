'use strict';

// `orch add` / `orch edit` set a job's resourceLimits through six flags, from the same flag table as every
// other field. An edit is a patch: a flag you omit leaves that key as it was, so the CLI merges onto the
// job's current limits. `--unset resourceLimits` clears all of it, `--unset resourceLimits.<key>` one key.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

async function run(argv, { current } = {}) {
  const calls = [];
  const deps = {
    send: async (command, payload) => {
      calls.push({ command, payload });
      return command === 'get-job' ? (current === undefined ? { id: 'j1' } : current) : {};
    },
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
  return { calls, exitCode, stderr, edit: calls.find(c => c.command === 'edit-job')?.payload, add: calls.find(c => c.command === 'add-job')?.payload };
}

const ADD = ['add', 'cron', 'j1', '--schedule', '0 8 * * *', '--command', 'node -v'];

describe('add', () => {
  test('every flag lands in resourceLimits with its type', async () => {
    const { add } = await run([...ADD,
      '--resource-enforce', 'warn', '--hard-factor', '4', '--soft-factor', '2',
      '--sustain', '60', '--max-cpu', '150', '--max-ram', '2048.5']);
    assert.deepEqual(add.resourceLimits, {
      enforce: 'warn', hardFactor: 4, softFactor: 2, sustainSeconds: 60, maxCpuPct: 150, maxRamMb: 2048.5,
    });
  });

  test('without any of them, no resourceLimits is sent', async () => {
    const { add } = await run(ADD);
    assert.ok(!('resourceLimits' in add));
  });

  test('a once job with a free-text flag in front of the id still finds its id', async () => {
    const { add } = await run(['add', '--once', '--max-ram', '512', 'once1', '--delay', '1h', '--command', 'node -v']);
    assert.equal(add.id, 'once1');
    assert.equal(add.resourceLimits.maxRamMb, 512);
  });
});

describe('refusals happen before the daemon is contacted and say what to type', () => {
  const cases = [
    [['--resource-enforce', 'kil'], /resourceLimits\.enforce.*kill, warn, off.*"kil"/s, /--resource-enforce/],
    [['--hard-factor', '1'], /resourceLimits\.hardFactor.*greater than 1.*100/s, /--hard-factor/],
    [['--hard-factor', 'big'], /--hard-factor expects a number.*"big"/s, /--hard-factor/],
    [['--soft-factor', '5'], /softFactor.*below.*hardFactor/s, /--soft-factor/],
    [['--sustain', '1'], /resourceLimits\.sustainSeconds.*2.*3600/s, /--sustain/],
    [['--sustain', '2.5'], /resourceLimits\.sustainSeconds.*whole/s, /--sustain/],
    [['--max-cpu', '0'], /resourceLimits\.maxCpuPct.*greater than 0/s, /--max-cpu/],
    [['--max-ram', '-3'], /resourceLimits\.maxRamMb.*greater than 0/s, /--max-ram/],
  ];
  for (const [flags, re, flagRe] of cases) {
    test(flags.join(' '), async () => {
      const { calls, exitCode, stderr } = await run([...ADD, ...flags]);
      assert.notEqual(exitCode, 0);
      assert.match(stderr, re);
      assert.match(stderr, flagRe);
      assert.equal(calls.length, 0, 'the daemon was contacted');
    });
  }

  for (const flagName of ['--resource-enforce', '--hard-factor', '--soft-factor', '--sustain', '--max-cpu', '--max-ram']) {
    test(`${flagName} without a value is an error, not a silent skip`, async () => {
      const { calls, exitCode, stderr } = await run([...ADD, flagName]);
      assert.notEqual(exitCode, 0);
      assert.match(stderr, new RegExp(`${flagName} needs a value`));
      assert.equal(calls.length, 0);
    });
  }
});

describe('edit', () => {
  const current = { id: 'j1', resourceLimits: { enforce: 'warn', hardFactor: 4, sustainSeconds: 60 } };

  test('merges the flags onto the current limits: an omitted key is left as it was', async () => {
    const { edit } = await run(['edit', 'j1', '--hard-factor', '6'], { current });
    assert.deepEqual(edit.updates.resourceLimits, { enforce: 'warn', hardFactor: 6, sustainSeconds: 60 });
  });

  test('works on a job that has no limits yet', async () => {
    const { edit } = await run(['edit', 'j1', '--max-ram', '800'], { current: { id: 'j1' } });
    assert.deepEqual(edit.updates.resourceLimits, { maxRamMb: 800 });
  });

  test('the merged result is validated: a lone --soft-factor above the stored hardFactor is refused', async () => {
    const { exitCode, stderr, edit } = await run(['edit', 'j1', '--soft-factor', '5'], { current });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /softFactor.*below.*hardFactor.*4/s);
    assert.equal(edit, undefined);
  });

  test('an unknown job is named, not turned into an empty edit', async () => {
    const { exitCode, stderr, edit } = await run(['edit', 'ghost', '--max-ram', '800'], { current: null });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /Job not found: "ghost"/);
    assert.equal(edit, undefined);
  });

  test('without a resource flag the job is not even fetched', async () => {
    const { calls, edit } = await run(['edit', 'j1', '--label', 'x'], { current });
    assert.deepEqual(calls.map(c => c.command), ['edit-job']);
    assert.ok(!('resourceLimits' in edit.updates));
  });

  test('--unset resourceLimits goes to the daemon as a whole-field unset', async () => {
    const { edit } = await run(['edit', 'j1', '--unset', 'resourceLimits'], { current });
    assert.deepEqual(edit.unset, ['resourceLimits']);
  });

  test('--unset resourceLimits.<key> removes that key and keeps the rest', async () => {
    const { edit } = await run(['edit', 'j1', '--unset', 'resourceLimits.hardFactor'], { current });
    assert.deepEqual(edit.updates.resourceLimits, { enforce: 'warn', sustainSeconds: 60 });
    assert.equal(edit.unset, undefined);
  });

  test('--unset of the last key clears the whole field', async () => {
    const { edit } = await run(['edit', 'j1', '--unset', 'resourceLimits.enforce'], { current: { id: 'j1', resourceLimits: { enforce: 'off' } } });
    assert.deepEqual(edit.unset, ['resourceLimits']);
    assert.ok(!('resourceLimits' in edit.updates));
  });

  test('--unset resourceLimits.<unknown> lists the keys', async () => {
    const { exitCode, stderr } = await run(['edit', 'j1', '--unset', 'resourceLimits.nope'], { current });
    assert.notEqual(exitCode, 0);
    assert.match(stderr, /resourceLimits\.nope.*enforce, hardFactor, softFactor, sustainSeconds, maxCpuPct, maxRamMb/s);
  });

  test('setting and unsetting the same thing is refused, naming the flag', async () => {
    let r = await run(['edit', 'j1', '--hard-factor', '5', '--unset', 'resourceLimits.hardFactor'], { current });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /--hard-factor/);
    r = await run(['edit', 'j1', '--hard-factor', '5', '--unset', 'resourceLimits'], { current });
    assert.notEqual(r.exitCode, 0);
    assert.match(r.stderr, /--unset resourceLimits/);
  });
});

describe('help', () => {
  test('documents the flags, the defaults and the unset forms', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (m) => lines.push(String(m));
    try {
      await run(['--help']);
    } finally {
      console.log = orig;
    }
    const text = lines.join('\n');
    for (const needle of ['--resource-enforce', '--hard-factor', '--soft-factor', '--sustain', '--max-cpu', '--max-ram', 'resourceLimits', 'orch show']) {
      assert.ok(text.includes(needle), `help does not mention ${needle}`);
    }
    assert.match(text, /default: 3/);
    assert.match(text, /default: 30/);
  });
});
