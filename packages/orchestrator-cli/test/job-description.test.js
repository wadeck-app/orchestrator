'use strict';

// A job's `description` is documentation for humans: plain text, trimmed, optional, at most 2000
// characters. It has no effect on scheduling. A value that is too long is REFUSED with the limit and
// the actual length, never cut: truncating would silently drop what someone wrote.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeCommands } = require('../src/commands');
const { Registry, validateJob } = require('../src/registry');
const { State } = require('../src/state');

const tmpDirs = [];

function makeEnv(job, audit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-descr-'));
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

describe('description is stored as written, trimmed', () => {
  test('add keeps it, with its line breaks', () => {
    const { registry } = makeEnv(cronJob({ description: 'Nightly backup.\nSecond line.' }));
    assert.equal(registry.get('j1').description, 'Nightly backup.\nSecond line.');
  });

  test('surrounding whitespace is trimmed', () => {
    const { registry } = makeEnv(cronJob({ description: '  \n  hello  \n' }));
    assert.equal(registry.get('j1').description, 'hello');
  });

  for (const empty of ['', '   ', '\n\t \n']) {
    test(`${JSON.stringify(empty)} is not stored: the key is absent`, () => {
      const { registry, file } = makeEnv(cronJob({ description: empty }));
      assert.ok(!('description' in registry.get('j1')), 'kept as an empty value in memory');
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(!('description' in raw.jobs[0]), 'kept as an empty value on disk');
    });
  }

  test('survives a reload from disk', () => {
    const { file } = makeEnv(cronJob({ description: 'kept\nacross restarts' }));
    const reloaded = new Registry(file);
    assert.equal(reloaded.get('j1').description, 'kept\nacross restarts');
  });

  test('a job saved without it loads unchanged', () => {
    const { registry, file } = makeEnv(cronJob());
    const before = JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0];
    const reloaded = new Registry(file);
    assert.deepEqual(reloaded.get('j1'), before);
    assert.ok(!('description' in reloaded.get('j1')));
    assert.ok(registry);
  });
});

describe('the 2000 character limit', () => {
  test('exactly 2000 is accepted', () => {
    const { registry } = makeEnv(cronJob({ description: 'x'.repeat(2000) }));
    assert.equal(registry.get('j1').description.length, 2000);
  });

  test('2001 is refused, and the message names the limit and the actual length', () => {
    assert.throws(
      () => validateJob(cronJob({ description: 'x'.repeat(2001) })),
      (err) => {
        assert.match(err.message, /description/);
        assert.match(err.message, /2000/, `no limit in: ${err.message}`);
        assert.match(err.message, /2001/, `no actual length in: ${err.message}`);
        return true;
      },
    );
  });

  test('the message says how much to cut, in the singular for one character', () => {
    assert.throws(() => validateJob(cronJob({ description: 'x'.repeat(2001) })), /Shorten it by 1 character\./);
    assert.throws(() => validateJob(cronJob({ description: 'x'.repeat(2005) })), /Shorten it by 5 characters\./);
  });

  test('the limit applies to the trimmed text, so padding does not count', () => {
    const { registry } = makeEnv(cronJob({ description: `  ${'x'.repeat(2000)}  ` }));
    assert.equal(registry.get('j1').description.length, 2000);
  });

  test('add refuses an over-long description and writes nothing', () => {
    const { registry } = makeEnv(null);
    assert.throws(() => registry.add(cronJob({ description: 'x'.repeat(2001) })), /2001/);
    assert.equal(registry.list().length, 0);
  });

  test('edit refuses it, names the lengths, and leaves the old text', () => {
    const { registry } = makeEnv(cronJob({ description: 'old' }));
    assert.throws(() => registry.edit('j1', { description: 'x'.repeat(2500) }), /2000.*2500|2500.*2000/s);
    assert.equal(registry.get('j1').description, 'old');
  });

  test('a description that is not text is refused, naming what it is', () => {
    assert.throws(() => validateJob(cronJob({ description: 42 })), /description.*text|string/i);
  });
});

describe('description is editable and clearable', () => {
  test('edit replaces it', () => {
    const { registry } = makeEnv(cronJob({ description: 'old' }));
    registry.edit('j1', { description: 'new\ntext' });
    assert.equal(registry.get('j1').description, 'new\ntext');
  });

  test('edit with a blank value clears it', () => {
    const { registry } = makeEnv(cronJob({ description: 'old' }));
    registry.edit('j1', { description: '   ' });
    assert.ok(!('description' in registry.get('j1')));
  });

  test('--unset description removes the key', () => {
    const { registry, file } = makeEnv(cronJob({ description: 'old' }));
    registry.edit('j1', {}, ['description']);
    assert.ok(!('description' in registry.get('j1')));
    assert.ok(!('description' in JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0]));
  });

  test('editing another field leaves the description alone', () => {
    const { registry } = makeEnv(cronJob({ description: 'keep me' }));
    registry.edit('j1', { label: 'Renamed' });
    assert.equal(registry.get('j1').description, 'keep me');
  });
});

describe('the audit names the field and not its text', () => {
  test('job.edited lists description among the changes without logging it', () => {
    const events = [];
    const audit = { log: (event, data) => events.push({ event, data }) };
    const { commands } = makeEnv(cronJob(), audit);
    const secretText = 'a long private explanation';

    commands['edit-job']({ id: 'j1', updates: { description: secretText } });

    const edited = events.find((e) => e.event === 'job.edited');
    assert.ok(edited.data.changes.includes('description'));
    assert.ok(!JSON.stringify(events).includes(secretText), 'the description text reached the audit');
  });

  test('job.added does not log the text either', () => {
    const events = [];
    const audit = { log: (event, data) => events.push({ event, data }) };
    const { commands } = makeEnv(null, audit);

    commands['add-job'](cronJob({ description: 'a long private explanation' }));

    assert.ok(!JSON.stringify(events).includes('private explanation'));
  });
});

describe('the daemon returns it with the job', () => {
  test('list-jobs and get-job carry description', () => {
    const { commands } = makeEnv(cronJob({ description: 'hello' }));
    assert.equal(commands['list-jobs']()[0].description, 'hello');
    assert.equal(commands['get-job']({ id: 'j1' }).description, 'hello');
  });
});

describe('edge values', () => {
  test('null is accepted as "no description": it is not stored', () => {
    const { registry, file } = makeEnv(cronJob({ description: null }));
    assert.ok(!('description' in registry.get('j1')), 'null kept in memory');
    assert.ok(!('description' in JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0]), 'null kept on disk');
  });

  test('edit with null clears an existing description', () => {
    const { registry } = makeEnv(cronJob({ description: 'old' }));
    registry.edit('j1', { description: null });
    assert.ok(!('description' in registry.get('j1')));
  });

  for (const [what, value, typeName] of [['an object', { text: 'x' }, 'object'], ['an array', ['x'], 'object'], ['a boolean', true, 'boolean'], ['a number', 42, 'number']]) {
    test(`${what} is refused with the full message`, () => {
      assert.throws(
        () => validateJob(cronJob({ description: value })),
        { message: `Job description must be text (got: ${typeName})` },
      );
    });
  }

  // The limit counts UTF-16 code units (String.length), not what a person sees as characters: an emoji is two.
  test('the 2000 limit counts UTF-16 code units: 1000 emoji fit, 1001 are refused with a length of 2002', () => {
    const emoji = '\u{1F600}';
    const { registry } = makeEnv(cronJob({ description: emoji.repeat(1000) }));
    assert.equal(registry.get('j1').description.length, 2000);
    assert.throws(
      () => validateJob(cronJob({ description: emoji.repeat(1001) })),
      { message: 'Job description must be 2000 characters or fewer (got: 2002). Shorten it by 2 characters.' },
    );
  });
});

describe('orch edit and the description, through the CLI', () => {
  const { runCli } = require('../src/cli');

  async function cli(argv, { tty = false, send = async () => ({}) } = {}) {
    const out = [];
    const err = [];
    let exitCode = 0;
    const origExit = process.exit;
    const origLog = console.log;
    const origError = console.error;
    const origTty = process.stdout.isTTY;
    process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
    console.log = (...a) => { out.push(a.join(' ')); };
    console.error = (m) => { err.push(String(m)); };
    Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
    try {
      await runCli(argv, { send, startDaemon: async () => {}, configDir: '/tmp/orch-test' });
    } catch (e) {
      if (e.message !== 'exit') {
        throw e;
      }
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origError;
      Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    }
    return { out: out.join('\n'), err: err.join('\n'), exitCode };
  }

  test('--description together with --unset description is refused, naming both flags, and sends nothing', async () => {
    const calls = [];
    const { err, exitCode } = await cli(['edit', 'j1', '--description', 'new', '--unset', 'description'], { send: async (c) => { calls.push(c); return {}; } });

    assert.deepEqual(calls, []);
    assert.equal(exitCode, 4);
    assert.equal(err, '\nError: Cannot set and unset "description" in the same command -- drop one of --description and --unset description.\n');
  });

  const MULTI = { id: 'j1', type: 'cron', schedule: '0 9 * * *', command: 'node -v', enabled: true, description: 'Line one.\nLine two.' };

  test('orch show carries the whole multi-line description: the JSON it prints gives the text back exactly', async () => {
    for (const tty of [true, false]) {
      const { out } = await cli(['show', 'j1'], { tty, send: async () => MULTI });
      assert.equal(JSON.parse(out).description, 'Line one.\nLine two.', `tty=${tty}`);
    }
  });

  test('orch list on a terminal never prints the description, with or without --verbose', async () => {
    for (const argv of [['list'], ['list', '--verbose']]) {
      const { out } = await cli(argv, { tty: true, send: async (c) => (c === 'list-jobs' ? [MULTI] : {}) });
      assert.match(out, /j1/);
      assert.doesNotMatch(out, /Line one|Line two/, argv.join(' '));
    }
  });
});
