'use strict';

// The edges of scripts/clean-test-temp.cjs (what it must never touch, how it refuses bad arguments) and of the
// value-kept rules of test/helpers/isolate-config-dir.js. The cleaner always runs against a scratch folder given as the
// temp dir (TEMP/TMP/TMPDIR), so nothing real is ever at risk.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRELOAD = path.join(__dirname, 'helpers', 'isolate-config-dir.js');
const CLEANER = path.join(__dirname, '..', 'scripts', 'clean-test-temp.cjs');
const USAGE = 'Usage: node scripts/clean-test-temp.cjs [--older-than-minutes N] [--dry-run]';

const made = [];
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cleanup-edges-'));
  made.push(dir);
  return dir;
}
after(() => {
  for (const dir of made) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function envFor(tempDir, extra = {}) {
  const env = { ...process.env, TEMP: tempDir, TMP: tempDir, TMPDIR: tempDir, ...extra };
  delete env.ORCH_TEST_TMP_ROOT;
  return env;
}

function clean(temp, ...args) {
  return spawnSync(process.execPath, [CLEANER, ...args], { env: envFor(temp), encoding: 'utf8' });
}

function folder(temp, name, { ageMinutes = 120, file = 'f.txt' } = {}) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), 'x');
  setAge(dir, ageMinutes);
  return dir;
}

function setAge(target, minutes) {
  const when = new Date(Date.now() - minutes * 60_000);
  fs.utimesSync(target, when, when);
}

describe('clean-test-temp: links are removed as links, never followed', () => {
  test('an old orch-* link to a folder OUTSIDE the temp root is unlinked; the target and its files survive', () => {
    const temp = scratch();
    const outside = scratch();
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'user data');
    fs.mkdirSync(path.join(outside, 'sub'));
    fs.writeFileSync(path.join(outside, 'sub', 'deep.txt'), 'more user data');
    const link = path.join(temp, 'orch-link');
    // A junction needs no privilege on Windows; it is a plain directory symlink elsewhere.
    fs.symlinkSync(outside, link, 'junction');
    // The link's own times (utimes would age the target instead).
    const when = new Date(Date.now() - 120 * 60_000);
    fs.lutimesSync(link, when, when);
    assert.ok(Date.now() - fs.lstatSync(link).mtimeMs > 60 * 60_000, 'precondition: the link itself is old');

    const run = clean(temp, '--older-than-minutes', '30');

    assert.equal(run.status, 0, `cleaner failed: ${run.stderr}`);
    assert.equal(fs.existsSync(link), false, 'the old link was kept');
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'user data', 'the cleaner followed the link and deleted the target\'s files');
    assert.equal(fs.readFileSync(path.join(outside, 'sub', 'deep.txt'), 'utf8'), 'more user data');
    assert.match(run.stdout, /removed 1\b/);
  });

  test('a dry run leaves the link and its target alone', () => {
    const temp = scratch();
    const outside = scratch();
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'user data');
    const link = path.join(temp, 'orch-link');
    fs.symlinkSync(outside, link, 'junction');
    const when = new Date(Date.now() - 120 * 60_000);
    fs.lutimesSync(link, when, when);

    const run = clean(temp, '--older-than-minutes', '30', '--dry-run');

    assert.equal(run.status, 0);
    assert.equal(fs.existsSync(link), true);
    assert.equal(fs.existsSync(path.join(outside, 'precious.txt')), true);
    assert.match(run.stdout, /would remove 1\b/);
  });
});

describe('clean-test-temp: what is looked at', () => {
  test('only direct children whose name starts with "orch-": "orch", "xorch-", "Orch-b", "orchestrator-data" and nested orch-* folders stay', () => {
    const temp = scratch();
    const kept = [
      folder(temp, 'orch'),
      folder(temp, 'xorch-a'),
      folder(temp, 'Orch-b'),
      folder(temp, 'orchestrator-data'),
      folder(path.join(temp, 'projects'), 'orch-nested'),
    ];
    const old = folder(temp, 'orch-a');

    const run = clean(temp, '--older-than-minutes', '30');

    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(old), false);
    for (const dir of kept) {
      assert.equal(fs.existsSync(dir), true, `${dir} was removed`);
      assert.equal(fs.existsSync(path.join(dir, 'f.txt')), true, `${dir} lost its content`);
    }
    assert.match(run.stdout, /removed 1\b/);
  });

  test('an old FILE named orch-*.log is removed like a folder (the prefix and the age are the only rules)', () => {
    const temp = scratch();
    const file = path.join(temp, 'orch-x.log');
    fs.writeFileSync(file, 'x');
    setAge(file, 120);

    const run = clean(temp, '--older-than-minutes', '30');

    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(file), false);
    assert.match(run.stdout, /removed 1\b/);
  });

  test('the age boundary: older than N minutes goes, younger stays, and an mtime in the future stays', () => {
    const temp = scratch();
    const older = folder(temp, 'orch-31', { ageMinutes: 31 });
    const younger = folder(temp, 'orch-29', { ageMinutes: 29 });
    const future = folder(temp, 'orch-future', { ageMinutes: -600 });

    const run = clean(temp, '--older-than-minutes', '30');

    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(older), false);
    assert.equal(fs.existsSync(younger), true);
    assert.equal(fs.existsSync(future), true);
    assert.match(run.stdout, /removed 1\b.*kept 2 recent one\(s\)/);
  });

  test('--older-than-minutes 0 removes everything that already exists, a future mtime excepted', () => {
    const temp = scratch();
    const now = folder(temp, 'orch-now', { ageMinutes: 0.01 });
    const old = folder(temp, 'orch-old');
    const future = folder(temp, 'orch-future', { ageMinutes: -600 });

    const run = clean(temp, '--older-than-minutes', '0');

    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(now), false);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(future), true);
  });

  test('the default age is 30 minutes', () => {
    const temp = scratch();
    const older = folder(temp, 'orch-31', { ageMinutes: 31 });
    const younger = folder(temp, 'orch-29', { ageMinutes: 29 });

    const run = clean(temp);

    assert.equal(run.status, 0, run.stderr);
    assert.equal(fs.existsSync(older), false);
    assert.equal(fs.existsSync(younger), true);
    assert.match(run.stdout, /older than 30 min/);
  });

  test('the summary names the temp dir; a dry run says "would remove" and names nothing as removed', () => {
    const temp = scratch();
    folder(temp, 'orch-old');
    folder(temp, 'orch-new', { ageMinutes: 1 });

    const run = clean(temp, '--older-than-minutes', '30', '--dry-run');

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, `clean-test-temp: would remove 1 orch-* folder(s) older than 30 min in ${fs.realpathSync(temp) === temp ? temp : run.stdout.split(' in ')[1].split(';')[0]}; kept 1 recent one(s)\n`);
    assert.equal(run.stdout.includes('removed 1'), false);
  });
});

describe('clean-test-temp: bad arguments are usage errors (exit 4) that say what is accepted', () => {
  const cases = [
    [['--older-than-minutes'], /--older-than-minutes needs a whole number of minutes \(0 or more\), got nothing\./],
    [['--older-than-minutes', '-5'], /got "-5"\./],
    [['--older-than-minutes', '1.5'], /got "1\.5"\./],
    [['--older-than-minutes', ''], /got ""\./],
    [['--older-than-minutes', '10m'], /got "10m"\./],
    [['--older-than-minutes', '--dry-run'], /got "--dry-run"\./],
    [['--bogus'], /Unknown argument "--bogus"\./],
    [['30'], /Unknown argument "30"\./],
  ];
  for (const [args, message] of cases) {
    test(`${JSON.stringify(args)}`, () => {
      const temp = scratch();
      const old = folder(temp, 'orch-old');

      const run = clean(temp, ...args);

      assert.equal(run.status, 4, `stdout: ${run.stdout} stderr: ${run.stderr}`);
      assert.match(run.stderr, /^clean-test-temp: /);
      assert.match(run.stderr, message);
      assert.ok(run.stderr.includes(USAGE), `no usage line in: ${run.stderr}`);
      assert.equal(run.stdout, '');
      assert.equal(fs.existsSync(old), true, 'a refused command must not delete anything');
    });
  }
});

describe('isolate-config-dir.js: a value already set is kept', () => {
  function seen(extra) {
    const outer = scratch();
    const probe = path.join(outer, 'probe.js');
    fs.writeFileSync(probe, [
      "const keys = ['ORCH_CONFIG_DIR', 'QUEUE_CONFIG_DIR', 'APP_CORE_CONFIG_DIR', 'QUEUE_SDK_OFF'];",
      "process.stdout.write(JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));",
    ].join('\n'));
    const env = envFor(outer, extra);
    for (const k of ['ORCH_CONFIG_DIR', 'QUEUE_CONFIG_DIR', 'APP_CORE_CONFIG_DIR', 'QUEUE_SDK_OFF']) {
      if (!(k in extra)) { delete env[k]; }
    }
    const run = spawnSync(process.execPath, ['--require', PRELOAD, probe], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  }

  test('nothing set: all four are given a throwaway value', () => {
    const got = seen({});

    assert.ok(got.ORCH_CONFIG_DIR && got.QUEUE_CONFIG_DIR && got.APP_CORE_CONFIG_DIR);
    assert.equal(got.QUEUE_SDK_OFF, '1');
    for (const k of ['ORCH_CONFIG_DIR', 'QUEUE_CONFIG_DIR', 'APP_CORE_CONFIG_DIR']) {
      assert.equal(path.resolve(got[k]).startsWith(path.resolve(os.homedir(), '.config')), false, `${k} points into the real ~/.config: ${got[k]}`);
    }
  });

  test('values chosen on purpose are not overridden', () => {
    const chosen = { ORCH_CONFIG_DIR: path.join(os.tmpdir(), 'mine-orch'), QUEUE_CONFIG_DIR: path.join(os.tmpdir(), 'mine-queue'), APP_CORE_CONFIG_DIR: path.join(os.tmpdir(), 'mine-core'), QUEUE_SDK_OFF: '0' };

    assert.deepEqual(seen(chosen), chosen);
  });

  test('an empty QUEUE_SDK_OFF counts as not set, and is switched on', () => {
    assert.equal(seen({ QUEUE_SDK_OFF: '' }).QUEUE_SDK_OFF, '1');
  });
});
