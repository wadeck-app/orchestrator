'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

// `orch add manual <id> --command ...` creates a job that only runs when triggered. Options that
// schedule something are refused by name, with the pointer to the type that does schedule.

async function run(argv, { tty = false, jobs = [] } = {}) {
  const calls = [];
  const lines = [];
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  const origTty = process.stdout.isTTY;
  let exitCode = 0;
  let stderr = '';
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.error = (msg) => { stderr += `${msg}\n`; };
  console.log = (...args) => { lines.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    await runCli(argv, {
      send: async (command, payload) => { calls.push({ command, payload }); return command === 'list-jobs' ? jobs : {}; },
      startDaemon: async () => {},
      configDir: '/tmp/orch-test',
    });
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
  }
  return { calls, exitCode, stderr, stdout: lines.join('\n') };
}

describe('orch add manual', () => {
  test('sends a manual job with the shared optional flags', async () => {
    const { calls, exitCode } = await run([
      'add', 'manual', 'deploy', '--command', 'node deploy.js', '--timeout', '600',
      '--retry-on-exit-codes', '7', '--retry-delays', '5', '--skip-exit-codes', '2',
      '--max-concurrency', '1', '--description', 'Ship it', '--trigger-mode', 'wait',
    ]);
    assert.equal(exitCode, 0);
    assert.equal(calls[0].command, 'add-job');
    assert.deepEqual(calls[0].payload, {
      id: 'deploy', type: 'manual', command: 'node deploy.js', enabled: true,
      timeoutSeconds: 600, maxConcurrency: 1, description: 'Ship it', triggerMode: 'wait',
      retryOnExitCodes: [7], retryDelays: [5], skipExitCodes: [2],
    });
  });

  for (const [option, args] of [
    ['--schedule', ['--schedule', '0 9 * * *']],
    ['--delay', ['--delay', '30']],
    ['--missed-firing', ['--missed-firing', 'catch-up']],
    ['--active-for', ['--active-for', '3w']],
    ['--active-from', ['--active-from', '2030-01-01']],
    ['--active-until', ['--active-until', '2030-01-01']],
  ]) {
    test(`${option} is refused, naming the option and the alternative`, async () => {
      const { calls, exitCode, stderr } = await run(['add', 'manual', 'deploy', '--command', 'x', ...args]);
      assert.equal(exitCode, 4);
      assert.ok(stderr.includes(option), `the option is not named: ${stderr}`);
      assert.match(stderr, /manual jobs have no schedule/i);
      assert.match(stderr, /orch add cron/);
      assert.equal(calls.length, 0, 'the daemon was called despite the refusal');
    });
  }

  test('--once combined with manual is not a thing: the missing-id usage lists manual', async () => {
    const { stderr } = await run(['add', 'manual']);
    assert.match(stderr, /orch add manual <id>/);
  });
});

describe('orch list shows the type', () => {
  test('a manual job reads as manual, not as a schedule', async () => {
    const { stdout } = await run(['list'], {
      tty: true,
      jobs: [{ id: 'deploy', type: 'manual', enabled: true, command: 'x' }],
    });
    assert.match(stdout, /deploy\s+manual\s+run with: orch trigger deploy/);
    assert.doesNotMatch(stdout, /undefined|NaN/);
  });
});

describe('orch timers', () => {
  test('a manual job is described as not scheduled, with no warning', async () => {
    const calls = [];
    const origError = console.error;
    const errors = [];
    console.error = (m) => { errors.push(String(m)); };
    const lines = [];
    const origLog = console.log;
    const origTty = process.stdout.isTTY;
    console.log = (...a) => { lines.push(a.join(' ')); };
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    try {
      await runCli(['timers'], {
        send: async (command) => { calls.push(command); return [{
          jobId: 'deploy', type: 'manual', enabled: true, armed: null, dueAt: null, windowEndsAt: null,
          nextFiring: null, windowState: null, spent: false, problem: null,
        }]; },
        startDaemon: async () => {},
        configDir: '/tmp/orch-test',
      });
    } finally {
      console.error = origError;
      console.log = origLog;
      Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    }
    const out = lines.join('\n');
    assert.deepEqual(errors, []);
    assert.match(out, /deploy\s+manual\s+manual\s+trigger only/);
    assert.match(out, /armed as configured/);
  });
});

// The CLI's own output for manual rows, and the refusals of the daemon's real command map reached through it.
async function runWith(argv, send, { tty }) {
  const out = [];
  const err = [];
  let exitCode = 0;
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  const origTty = process.stdout.isTTY;
  const origExitCode = process.exitCode;
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  console.log = (...a) => { out.push(a.join(' ')); };
  console.error = (m) => { err.push(String(m)); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  let thrown;
  try {
    await runCli(argv, { send, startDaemon: async () => {}, configDir: '/tmp/orch-test' });
  } catch (e) {
    if (e.message !== 'exit') {
      thrown = e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
    process.exitCode = origExitCode;
  }
  return { out: out.join('\n'), err: err.join('\n'), exitCode, thrown };
}

const timerRow = (over) => ({
  jobId: 'deploy', type: 'manual', enabled: true, armed: null, dueAt: null, windowEndsAt: null,
  nextFiring: null, windowState: null, spent: false, problem: null, ...over,
});

describe('orch timers with a manual row, piped and as JSON', () => {
  for (const [what, argv, tty] of [['piped', ['timers'], false], ['--json on a terminal', ['timers', '--json'], true], ['--json piped', ['timers', '--json'], false]]) {
    test(`${what}: the bare rows on stdout, no warning on stderr, exit 0`, async () => {
      const rows = [timerRow({}), timerRow({ jobId: 'old', enabled: false })];
      const { out, err, exitCode } = await runWith(argv, async () => rows, { tty });

      assert.deepEqual(JSON.parse(out), rows);
      assert.equal(err, '');
      assert.equal(exitCode, 0);
    });
  }

  test('a switched-off manual row on a terminal reads like an enabled one and is not counted as a failure', async () => {
    const { out, err } = await runWith(['timers'], async () => [timerRow({ enabled: false })], { tty: true });

    assert.match(out, /^✓ deploy\s+manual\s+manual\s+trigger only/m);
    assert.match(out, /All 1 job\(s\) armed as configured\./);
    assert.equal(err, '');
  });
});

describe('orch edit on a manual job, against the daemon\'s real command map', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { makeCommands } = require('../src/commands');
  const { Registry } = require('../src/registry');
  const { State } = require('../src/state');

  function realDaemon() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-manual-'));
    const registry = new Registry(path.join(dir, 'registry.json'));
    registry.add({ id: 'deploy', type: 'manual', command: 'echo run', enabled: true, triggerMode: 'fire-and-forget' });
    const scheduler = { killJob: async () => ({ killed: false }), skipNextFiring: () => {}, scheduleJob: () => {}, unscheduleJob: () => {} };
    const commands = makeCommands(registry, new State(path.join(dir, 'state.json')), scheduler, dir);
    return { registry, send: async (command, payload) => commands[command](payload) };
  }

  for (const [option, args, field] of [['--schedule', ['--schedule', '0 9 * * *'], 'schedule'], ['--delay', ['--delay', '30'], 'delaySeconds']]) {
    test(`${option} is refused naming the field and the way out, and the job is unchanged`, async () => {
      const { registry, send } = realDaemon();
      const before = JSON.stringify(registry.get('deploy'));

      const { thrown, out } = await runWith(['edit', 'deploy', ...args], send, { tty: false });

      assert.ok(thrown, 'the edit was accepted');
      assert.equal(thrown.message, `Manual jobs have no schedule: "${field}" is not accepted on a manual job. Remove it, or use a cron job (orch add cron) to run on a schedule.`);
      assert.equal(out, '');
      assert.equal(JSON.stringify(registry.get('deploy')), before);
    });
  }
});
