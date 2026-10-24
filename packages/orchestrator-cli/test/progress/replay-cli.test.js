'use strict';

// `orch progress replay <jobId>`: the leave-one-out replay as a command. Fixtures are synthetic
// (test/progress/fixtures); the command reads registry.json, state.json and the run logs of a config dir.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { runCli } = require('../../src/cli');
const { HELP_TEXT } = require('../../src/help-text');
const { PROGRESS_STRATEGY_IDS } = require('../../src/progress/registry');
const { replayFixture, materialize } = require('./helpers/replay-fixture');
const { cleanupTemp, tempDir, buildCase } = require('./helpers/fixture-builder');

after(cleanupTemp);

const FIXTURES = path.join(__dirname, 'fixtures');
const CEILINGS = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'mae-ceilings.json'), 'utf8'));

async function orch(argv, configDir) {
  const out = [];
  const err = [];
  const origExit = process.exit;
  const origLog = console.log;
  const origErr = console.error;
  let exitCode = 0;
  console.log = (m) => { out.push(`${m}\n`); };
  console.error = (m) => { err.push(`${m}\n`); };
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  try {
    await runCli(argv, { configDir, send: () => { throw new Error('the replay must not need the daemon'); }, startDaemon: () => {} });
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origErr;
  }
  return { out: out.join(''), err: err.join(''), exitCode };
}

describe('replayFixture (the helper shares the command code path)', () => {
  test('minutes-stable: default strategies are reported, history has runs replayed and a small error', () => {
    const report = replayFixture(path.join(FIXTURES, 'minutes-stable'));
    const ids = report.strategies.map(s => s.id);
    // Every strategy is listed: the ones the job lacks options for (ratio, log-declared) as not configured.
    assert.deepEqual(ids, ['declared', 'ratio', 'log-declared', 'log-learned', 'ensemble', 'history']);
    const history = report.strategies.find(s => s.id === 'history');
    assert.ok(report.runs >= 3, `runs ${report.runs}`);
    assert.ok(history.metrics.coverage > 0);
    assert.ok(history.metrics.maePct !== null && history.metrics.maePct < 0.05, `history MAE ${history.metrics.maePct}`);
    assert.ok(report.best !== null);
    assert.match(report.verdict, new RegExp(report.best));
  });

  test('--strategy restricts the report to one strategy', () => {
    const report = replayFixture(path.join(FIXTURES, 'minutes-stable'), { strategy: 'history' });
    assert.deepEqual(report.strategies.map(s => s.id), ['history']);
  });

  test('an unknown strategy is refused with the registered ids', () => {
    assert.throws(() => replayFixture(path.join(FIXTURES, 'minutes-stable'), { strategy: 'nope' }),
      (e) => /unknown strategy "nope"/.test(e.message) && PROGRESS_STRATEGY_IDS.every(id => e.message.includes(id)));
  });

  test('a strategy that needs options the job does not have is reported as unavailable with the fix, not as a failure', () => {
    const report = replayFixture(path.join(FIXTURES, 'minutes-stable'), { strategy: 'ratio' });
    const s = report.strategies[0];
    assert.equal(s.id, 'ratio');
    assert.match(s.unavailable, /--progress ratio --progress-options/);
    assert.equal(report.best, null);
  });

  test('fewer than 3 usable runs: no table, an actionable verdict', () => {
    const dir = tempDir();
    const c = buildCase(dir, { runs: [{ agoMin: 60, durationSec: 600 }, { agoMin: 120, durationSec: 600 }] });
    const { buildReplayReport } = require('../../src/progress/replay-report');
    const report = buildReplayReport({ job: c.job, history: c.history, configDir: dir });
    assert.equal(report.best, null);
    assert.match(report.verdict, /2 usable run/);
    assert.match(report.verdict, /at least 3/);
    assert.match(report.verdict, /exit code 0/);
  });
});

describe('accuracy regression guard', () => {
  for (const name of Object.keys(CEILINGS).filter(k => !k.startsWith('_'))) {
    test(`${name}: the replay error of every listed strategy stays under its ceiling`, () => {
      const report = replayFixture(path.join(FIXTURES, name));
      for (const [id, ceiling] of Object.entries(CEILINGS[name])) {
        const s = report.strategies.find(x => x.id === id);
        assert.ok(s, `${name}: strategy ${id} is missing from the report`);
        assert.ok(s.metrics.maePct !== null, `${name}/${id}: no estimate was replayed`);
        assert.ok(s.metrics.maePct <= ceiling.maePct,
          `${name}/${id}: MAE ${s.metrics.maePct} is above the ceiling ${ceiling.maePct}; if the change is intended, raise the ceiling in fixtures/mae-ceilings.json and say why`);
        assert.ok(s.metrics.coverage >= ceiling.minCoverage,
          `${name}/${id}: coverage ${s.metrics.coverage} fell under ${ceiling.minCoverage}`);
      }
    });
  }
});

describe('orch progress replay (CLI, in process)', () => {
  test('prints a table with one row per strategy and a verdict', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const { out, exitCode } = await orch(['progress', 'replay', 'minutes-stable'], configDir);
    assert.equal(exitCode, 0);
    for (const id of ['declared', 'log-learned', 'history']) {
      assert.match(out, new RegExp(`^${id}\\s`, 'm'));
    }
    assert.match(out, /MAE s/);
    assert.match(out, /@25%/);
    assert.match(out, /flips/);
    assert.match(out, /^Best: /m);
  });

  test('--json prints the report', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const { out } = await orch(['progress', 'replay', 'minutes-stable', '--strategy', 'history', '--json'], configDir);
    const parsed = JSON.parse(out);
    assert.equal(parsed.jobId, 'minutes-stable');
    assert.deepEqual(parsed.strategies.map(s => s.id), ['history']);
  });

  test('--sample-every changes the sampling', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const a = JSON.parse((await orch(['progress', 'replay', 'minutes-stable', '--strategy', 'history', '--json'], configDir)).out);
    const b = JSON.parse((await orch(['progress', 'replay', 'minutes-stable', '--strategy', 'history', '--sample-every', '25', '--json'], configDir)).out);
    assert.ok(a.strategies[0].metrics.samples > b.strategies[0].metrics.samples);
    assert.equal(b.sampleEveryPercent, 25);
  });

  test('unknown job: exit 1, lists the known ids', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const { err, exitCode } = await orch(['progress', 'replay', 'ghost'], configDir);
    assert.equal(exitCode, 1);
    assert.match(err, /No job has the id "ghost"/);
    assert.match(err, /minutes-stable/);
  });

  test('missing registry in the config dir: exit 1 and says where it looked', async () => {
    const dir = tempDir();
    const { err, exitCode } = await orch(['progress', 'replay', 'x'], dir);
    assert.equal(exitCode, 1);
    assert.match(err, /registry\.json/);
    assert.match(err, /ORCH_CONFIG_DIR/);
  });

  test('usage errors exit 4: no job id, unknown flag, bad --sample-every, unknown strategy, unknown sub-command', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const cases = [
      [['progress', 'replay'], /Missing job id/],
      [['progress', 'replay', 'minutes-stable', '--wat'], /Unknown option "--wat"/],
      [['progress', 'replay', 'minutes-stable', '--sample-every', '0'], /--sample-every must be a whole number from 1 to 50/],
      [['progress', 'replay', 'minutes-stable', '--strategy'], /--strategy needs a value/],
      [['progress', 'replay', 'minutes-stable', '--strategy', 'nope'], /unknown strategy "nope"/],
      [['progress', 'bogus'], /Unknown sub-command "bogus"/],
      [['progress'], /Missing sub-command/],
    ];
    for (const [argv, re] of cases) {
      const { err, exitCode } = await orch(argv, configDir);
      assert.equal(exitCode, 4, argv.join(' '));
      assert.match(err, re, argv.join(' '));
    }
  });

  test('the command writes nothing into the config dir (the CLI invocation log aside: every command leaves one line there)', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const snapshot = () => JSON.stringify(fs.readdirSync(configDir, { recursive: true })
      .filter(f => !/\.ndjson$/.test(f) && fs.statSync(path.join(configDir, f)).isFile()).map(f => `${f}:${fs.statSync(path.join(configDir, f)).mtimeMs}`).sort());
    const before = snapshot();
    await orch(['progress', 'replay', 'minutes-stable'], configDir);
    assert.equal(snapshot(), before);
  });

  test('orch --help documents the command', () => {
    assert.match(HELP_TEXT, /orch progress replay <jobId>/);
    assert.match(HELP_TEXT, /--sample-every/);
    assert.match(HELP_TEXT, /--strategy/);
  });
});

describe('orch progress replay (the real CLI process)', () => {
  test('exit 0 and the table on stdout, against a fixture config dir', async () => {
    const { configDir } = materialize(path.join(FIXTURES, 'minutes-stable'));
    const cliTs = path.join(__dirname, '..', '..', 'src', 'cli.ts');
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--require', 'tsx/cjs', cliTs, 'progress', 'replay', 'minutes-stable', '--strategy', 'history'], {
        env: { ...process.env, ORCH_CONFIG_DIR: configDir },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^history\s/m);
    assert.match(result.stdout, /^Best: history/m);
  });
});
