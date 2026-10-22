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
