'use strict';

// "I do not want to see colour encodings when I run a dev server" -- proved with REAL processes, no mock of the
// environment: a job script reports what it was started with and what its colour library decides, and prints a line
// full of escape codes, through the direct spawn path, the supervised path (the real supervisor binary) and
// `orch exec`. The daemon's own environment is made to force colour first, which is what the user's shell does.
const { test, describe, afterEach, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { Registry }  = require('../src/registry');
const { State }     = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { ExecManager } = require('../src/exec-manager');
const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised } = require('../src/supervised-run');
const { endLeftoverRuns, withPidFile } = require('./helpers/end-leftover-runs');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const PICOCOLORS = require.resolve('picocolors');
const FORCING = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };

// What the daemon's environment looks like when started from a shell that forces colour.
const saved = {};
before(() => {
  for (const name of ['FORCE_COLOR', 'CLICOLOR_FORCE', 'NO_COLOR']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  Object.assign(process.env, FORCING);
});
after(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const dirs = [];
const schedulers = [];
afterEach(async () => {
  while (schedulers.length > 0) {
    await schedulers.pop().stop();
  }
});
after(async () => {
  await endLeftoverRuns(dirs);
});

// ESC, BEL and ST are built by the job itself, so no escape has to survive being written into a source file.
const SCRIPT = `
const E = String.fromCharCode(27), B = String.fromCharCode(7), ST = E + String.fromCharCode(92);
const pc = require(${JSON.stringify(PICOCOLORS)});
console.log('PROBE ' + JSON.stringify({
  isTTY: Boolean(process.stdout.isTTY),
  NO_COLOR: process.env.NO_COLOR ?? null,
  FORCE_COLOR: process.env.FORCE_COLOR ?? null,
  CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? null,
  picocolorsColor: pc.isColorSupported,
  painted: pc.red('x'),
}));
// What a tool that ignores the environment prints: SGR, an OSC title, an OSC hyperlink, erase codes.
console.log(E + '[31mred' + E + '[0m ' + E + ']0;title' + B + E + ']8;;http://x.test' + ST + 'link' + E + ']8;;' + ST + ' ' + E + '[2K' + E + '[1Gdone');
console.error(E + '[33mwarn' + E + '[39m on stderr');
`;

function probeOf(logText) {
  const line = logText.split('\n').find((l) => l.includes('PROBE '));
  assert.ok(line, `no PROBE line in the log:\n${logText}`);
  return JSON.parse(line.slice(line.indexOf('PROBE ') + 'PROBE '.length));
}

function jobFor(holder, extra = {}) {
  dirs.push(holder);
  const file = path.join(holder, 'probe.js');
  fs.writeFileSync(file, withPidFile(SCRIPT));
  return { id: 'probe', type: 'cron', schedule: '0 8 * * *', label: 'Probe', enabled: true, triggerMode: 'wait',
    command: `node "${file}"`, ...extra };
}

function latestLog(dir, jobId) {
  const folder = path.join(dir, 'logs', 'jobs', jobId);
  const files = fs.readdirSync(folder).filter((f) => f.endsWith('.log')).sort();
  return fs.readFileSync(path.join(folder, files[files.length - 1]), 'utf8');
}

function makeScheduler(job, { supervised, ...extra }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-'));
  dirs.push(dir);
  const registry = new Registry(path.join(dir, 'registry.json'));
  const state = new State(path.join(dir, 'state.json'));
  registry.load();
  registry.add(job);
  const sched = new Scheduler(registry, state, {
    configDir: dir,
    liveness: async () => false,
    sampleUsage: async () => null,
    eventPublisher: { publish: () => {} },
    ...(supervised
      ? { supervisor: (request) => startSupervised({ supervisorPath, configDir: dir, heartbeatMs: 50, pollMs: 25 }, request) }
      : {}),
    ...extra,
  });
  schedulers.push(sched);
  return { sched, dir };
}

const PATHS = [['direct spawn', false], ['supervised', true]];

for (const [pathName, supervised] of PATHS) {
  describe(`a job through the ${pathName} path`, () => {
    test('is started with NO_COLOR=1 and FORCE_COLOR=0, CLICOLOR_FORCE gone, and picocolors sees no colour', async () => {
      const job = jobFor(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-script-')));
      const { sched, dir } = makeScheduler(job, { supervised });

      assert.deepEqual(await sched._fire(job), { exitCode: 0 });

      assert.deepEqual(probeOf(latestLog(dir, 'probe')), {
        isTTY: false, NO_COLOR: '1', FORCE_COLOR: '0', CLICOLOR_FORCE: null, picocolorsColor: false, painted: 'x',
      });
    });

    test('jobsNoColor: false hands the job the inherited environment, which forces colour (the probe is not vacuous)', async () => {
      const job = jobFor(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-script-')));
      const { sched, dir } = makeScheduler(job, { supervised, jobsNoColor: false });

      assert.deepEqual(await sched._fire(job), { exitCode: 0 });

      const probe = probeOf(latestLog(dir, 'probe'));
      assert.equal(probe.FORCE_COLOR, '1');
      assert.equal(probe.CLICOLOR_FORCE, '1');
      assert.equal(probe.NO_COLOR, null);
      assert.equal(probe.picocolorsColor, true, 'with the inherited FORCE_COLOR=1 the library paints');
    });

    test('the job\'s own env wins per variable: FORCE_COLOR it sets stays, NO_COLOR it did not set is still 1', async () => {
      const job = jobFor(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-script-')), { env: { FORCE_COLOR: '2' } });
      const { sched, dir } = makeScheduler(job, { supervised });

      assert.deepEqual(await sched._fire(job), { exitCode: 0 });

      const probe = probeOf(latestLog(dir, 'probe'));
      assert.equal(probe.FORCE_COLOR, '2');
      assert.equal(probe.NO_COLOR, '1');
      assert.equal(probe.CLICOLOR_FORCE, null);
    });

    test('the run log holds the job\'s lines without escape sequences, SGR, OSC and erase codes alike, stderr too', async () => {
      const job = jobFor(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-script-')));
      const { sched, dir } = makeScheduler(job, { supervised });

      await sched._fire(job);

      const log = latestLog(dir, 'probe');
      assert.equal(log.includes('\u001b'), false, `an ESC reached the run log:\n${JSON.stringify(log)}`);
      assert.match(log, /\] red link done\n/);
      assert.match(log, /\] \[stderr\] warn on stderr\n/);
      assert.match(log, /\[job:finished\] exitCode=0/, 'the daemon\'s own markers are still there');
    });
  });
}

describe('the daemon\'s own log lines', () => {
  test('are written untouched: only a job\'s output is stripped', () => {
    const { RunLogger } = require('../src/logger');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-logger-'));
    dirs.push(dir);
    const logger = new RunLogger(dir, 'j', '2026-10-24T10:00:00.000Z');
    logger.write('[warn] kept \u001b[31mas is\u001b[0m');
    logger.writeOutput('\u001b[31mred\u001b[0m');
    logger.writeOutput('\u001b[2K', '[stderr] ');
    logger.close();
    const text = fs.readFileSync(logger.filePath, 'utf8');
    assert.match(text, /\] \[warn\] kept \u001b\[31mas is\u001b\[0m\n/);
    assert.match(text, /\] red\n/);
    assert.equal(text.split('\n').filter(Boolean).length, 2, 'a line that is only an erase code writes nothing');
  });
});

describe('orch exec', () => {
  test('runs with NO_COLOR=1 and FORCE_COLOR=0 and keeps escape sequences out of its output', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-exec-'));
    dirs.push(holder);
    const file = path.join(holder, 'probe.js');
    fs.writeFileSync(file, withPidFile(SCRIPT));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-execcfg-'));
    dirs.push(configDir);
    const manager = new ExecManager(configDir);

    const { runId } = manager.fireExec(`node "${file}"`, {});
    const run = await waitFinished(manager, runId);

    const probe = probeOf(run.logs.join('\n'));
    assert.equal(probe.NO_COLOR, '1');
    assert.equal(probe.FORCE_COLOR, '0');
    assert.equal(probe.CLICOLOR_FORCE, null);
    assert.equal(probe.picocolorsColor, false);
    assert.equal(run.logs.join('\n').includes('\u001b'), false, JSON.stringify(run.logs));
    assert.ok(run.logs.includes('red link done'));
    assert.ok(run.logs.includes('[stderr] warn on stderr'));
  });

  test('the env of the exec wins per variable', async () => {
    const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-exec-'));
    dirs.push(holder);
    const file = path.join(holder, 'probe.js');
    fs.writeFileSync(file, withPidFile(SCRIPT));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-no-colour-execcfg-'));
    dirs.push(configDir);
    const manager = new ExecManager(configDir);

    const { runId } = manager.fireExec(`node "${file}"`, { env: { NO_COLOR: 'mine' } });
    const run = await waitFinished(manager, runId);

    const probe = probeOf(run.logs.join('\n'));
    assert.equal(probe.NO_COLOR, 'mine');
    assert.equal(probe.FORCE_COLOR, '0');
  });
});

async function waitFinished(manager, runId) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = manager.get(runId);
    if (run && run.finishedAt != null) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`exec run ${runId} did not finish within 20 s`);
}
