'use strict';

// `orch stop`, `orch restart` and `orch cli update` end the daemon; with no supervisor, the running jobs die
// with it. Each says so BEFORE acting (warn, never ask: scripts must not block), naming the jobs and the way out.
// `orch status` shows the supervisor state (also covered in cli-status-details.test.js).
// `orch exec` commands are never supervised, so they die with the daemon whatever the supervisor says: the same
// commands name them too, from `exec-list` (not from get-daemon-info, which the dashboard reads and never carries a command line).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');
const { execRunning, execWarning } = require('../src/unsupervised-warning');

const dirs = [];
afterEach(() => {
  process.exitCode = 0;
  while (dirs.length > 0) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function runningConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-unsup-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
  return dir;
}

const NOTE = 'supervisedJobs is on (the default), but there is no supervisor executable for linux-arm64.';
const INFO_UNAVAILABLE = { supervisor: { requested: true, active: false, note: NOTE } };
const INFO_OFF = { supervisor: { requested: false, active: false } };
const INFO_ACTIVE = { supervisor: { requested: true, active: true } };

const open = (extra = {}) => ({ startedAt: '2026-10-18T10:00:00.000Z', exitCode: null, pid: 1, ...extra });
const STATE = {
  server: [open()],
  scraper: [open()],
  guarded: [open({ supervised: true })],
  done: [{ ...open(), finishedAt: '2026-10-18T10:05:00.000Z', exitCode: 0 }],
};

/** Runs the CLI and records, in one ordered list, the daemon calls and the stderr lines. */
async function run(argv, { info, state = STATE, platform = 'linux', infoError, updateRuns, execRuns = [], execError } = {}) {
  const events = [];
  const send = async (command) => {
    events.push(`call:${command}`);
    if (command === 'get-daemon-info') {
      if (infoError) { throw infoError; }
      return info;
    }
    if (command === 'list-state') {
      return state;
    }
    if (command === 'exec-list') {
      if (execError) { throw execError; }
      return execRuns;
    }
    return {};
  };
  const origErr = console.error;
  const origLog = console.log;
  console.error = (...a) => { events.push(`err:${a.join(' ')}`); };
  console.log = () => {};
  try {
    await runCli(argv, {
      send, startDaemon: () => {}, configDir: runningConfigDir(), platform,
      cliUpdate: { version: '2026.10.25-123-abcdef12', updaterPath: '/fake/updater.cjs', run: async () => { events.push('call:updater'); updateRuns?.push(1); } },
    });
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
  const err = events.filter(e => e.startsWith('err:')).join('\n');
  return { events, err };
}

const ACTIONS = [
  { name: 'orch stop', argv: ['stop'], acts: 'call:quit' },
  { name: 'orch restart', argv: ['restart'], acts: 'call:restart' },
  { name: 'orch cli update', argv: ['cli', 'update'], acts: 'call:updater' },
];

for (const { name, argv, acts } of ACTIONS) {
  describe(name, () => {
    test('warns before acting, names the unsupervised running jobs, says they are killed, and points at a reinstall (Linux ships a supervisor like the others)', async () => {
      const { events, err } = await run(argv, { info: INFO_UNAVAILABLE });

      assert.match(err, /warning/i);
      assert.match(err, /2 running job\(s\)/);
      assert.match(err, /server, scraper/);
      assert.doesNotMatch(err, /guarded|done/, 'a supervised job survives and a finished one is not running');
      assert.match(err, /killed with the daemon/);
      assert.match(err, /no supervisor executable for linux-arm64/, 'the daemon\'s own reason is repeated');
      assert.doesNotMatch(err, /no supervisor in the npm install on Linux|source checkout/, 'Linux is a supported target, with a supervisor package');
      assert.match(err, /orch cli update/);
      assert.match(err, /wait for the jobs to finish/);
      const warnedAt = events.findIndex(e => e.startsWith('err:'));
      assert.ok(warnedAt >= 0 && warnedAt < events.indexOf(acts), `the warning must come before the action: ${events.join(' | ')}`);
    });

    test('with supervisedJobs: false names that setting as the way out (not on Linux)', async () => {
      const { err } = await run(argv, { info: INFO_OFF, platform: 'win32' });

      assert.match(err, /server, scraper/);
      assert.match(err, /supervisedJobs is false in config\.yml/);
      assert.match(err, /supervisedJobs: true/);
      assert.doesNotMatch(err, /source checkout/);
    });

    test('on a non-Linux platform with a missing supervisor points at a reinstall', async () => {
      const { err } = await run(argv, { info: INFO_UNAVAILABLE, platform: 'darwin' });

      assert.match(err, /orch cli update/);
      assert.doesNotMatch(err, /source checkout/);
    });

    test('says nothing when the supervisor is active', async () => {
      const { err, events } = await run(argv, { info: INFO_ACTIVE });

      assert.equal(err, '');
      assert.ok(events.includes(acts));
    });

    test('says nothing when no job is running without a supervisor', async () => {
      const { err, events } = await run(argv, { info: INFO_UNAVAILABLE, state: { guarded: STATE.guarded, done: STATE.done } });

      assert.equal(err, '');
      assert.ok(events.includes(acts));
    });

    test('a daemon that cannot report its supervisor is still acted on, and the user is told the check failed', async () => {
      const { err, events } = await run(argv, { infoError: new Error('unknown command get-daemon-info') });

      assert.match(err, /could not check whether the running jobs survive.*unknown command get-daemon-info/);
      assert.ok(events.includes(acts), 'the warning must never block the action');
    });
  });
}

describe('orch stop --kill-jobs', () => {
  test('does not warn: the jobs are being ended on purpose', async () => {
    const { err } = await run(['stop', '--kill-jobs'], { info: INFO_UNAVAILABLE });

    assert.equal(err, '');
  });
});

describe('orch cli update', () => {
  test('a daemon that is down is not a problem: nothing to warn about, the update goes ahead', async () => {
    const down = Object.assign(new Error('Orchestrator is not running'), { code: 'ECONNREFUSED' });
    const { err, events } = await run(['cli', 'update'], { infoError: down });

    assert.equal(err, '');
    assert.ok(events.includes('call:updater'));
  });
});

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const execRun = (over = {}) => ({
  runId: 'exec-1793440488970-f766fc19', command: 'npm run build', startedAt: ago(125_000), status: 'running', exitCode: null, pid: 7, logs: [], ...over,
});

describe('running orch exec commands', () => {
  for (const { name, argv, acts } of ACTIONS) {
    test(`${name} names them even when the supervisor is active, since exec is never supervised`, async () => {
      const { events, err } = await run(argv, { info: INFO_ACTIVE, execRuns: [execRun(), execRun({ runId: 'exec-2', status: 'done', command: 'finished one' })] });

      assert.match(err, /warning/i);
      assert.match(err, /1 running exec command\(s\)/);
      assert.match(err, /exec-1793440488970-f766fc19/);
      assert.match(err, /npm run build/);
      assert.match(err, /running for 2m0\ds/);
      assert.match(err, /killed with the daemon/);
      assert.match(err, /wait for (it|them) to finish or accept (its|their) loss/i);
      assert.doesNotMatch(err, /exec-2|finished one/, 'a finished command is not running');
      assert.doesNotMatch(err, /supervisedJobs|orch status/, 'exec is never supervised, and orch status does not list it');
      const warnedAt = events.findIndex(e => e.startsWith('err:'));
      assert.ok(warnedAt >= 0 && warnedAt < events.indexOf(acts), `the warning must come before the action: ${events.join(' | ')}`);
    });

    test(`${name} says nothing when no exec command is running`, async () => {
      const { err, events } = await run(argv, { info: INFO_ACTIVE, execRuns: [execRun({ status: 'done' }), execRun({ status: 'killed' })] });

      assert.equal(err, '');
      assert.ok(events.includes(acts));
    });

    test(`${name} warns about the jobs and about the exec commands separately`, async () => {
      const { err } = await run(argv, { info: INFO_OFF, execRuns: [execRun()] });

      assert.match(err, /2 running job\(s\).*server, scraper/s);
      assert.match(err, /1 running exec command\(s\)/);
    });

    test(`${name}: a daemon that cannot list them is still acted on, and the user is told the check failed`, async () => {
      const { err, events } = await run(argv, { info: INFO_ACTIVE, execError: new Error('unknown command exec-list') });

      assert.match(err, /could not check whether the running exec commands survive.*unknown command exec-list/);
      assert.match(err, /orch exec/);
      assert.ok(events.includes(acts), 'the warning must never block the action');
    });

    test(`${name}: an answer that is not a list is said, not read as "nothing running"`, async () => {
      const { err } = await run(argv, { info: INFO_ACTIVE, execRuns: { error: 'nope' } });

      assert.match(err, /could not check whether the running exec commands survive.*not a list/);
    });
  }

  test('orch stop --kill-jobs ends the jobs on purpose but does not end exec commands: it still names them', async () => {
    const { err } = await run(['stop', '--kill-jobs'], { info: INFO_UNAVAILABLE, execRuns: [execRun()] });

    assert.doesNotMatch(err, /running job\(s\)/);
    assert.match(err, /1 running exec command\(s\)/);
  });

  test('a daemon that is down has nothing to lose: no exec warning, no failure notice', async () => {
    const down = Object.assign(new Error('Orchestrator is not running'), { code: 'ECONNREFUSED' });
    const { err } = await run(['cli', 'update'], { infoError: down, execError: down });

    assert.equal(err, '');
  });
});

describe('execRunning / execWarning', () => {
  const NOW = Date.parse('2026-10-31T10:00:00.000Z');
  const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

  test('execRunning keeps only the commands still running', () => {
    const runs = [execRun({ runId: 'a' }), execRun({ runId: 'b', status: 'failed' }), execRun({ runId: 'c', status: 'killed' })];

    assert.deepEqual(execRunning(runs).map(r => r.runId), ['a']);
  });

  test('execWarning is null when nothing runs', () => {
    assert.equal(execWarning('orch stop', [], NOW), null);
  });

  test('execWarning gives one line per command: id, how long, the command on a single line, cut when long', () => {
    const long = 'node build.js ' + 'x'.repeat(200);
    const text = execWarning('orch restart', [
      execRun({ runId: 'exec-a', startedAt: at(45), command: 'echo\n  two   lines' }),
      execRun({ runId: 'exec-b', startedAt: at(3725), command: long }),
    ], NOW);

    const lines = text.split('\n');
    assert.match(lines[0], /^warning: orch restart will kill 2 running exec command\(s\) with the daemon/);
    assert.ok(lines.some(l => /exec-a\s+running for 45s\s+echo two lines$/.test(l)), text);
    assert.ok(lines.some(l => /exec-b\s+running for 1h02m\s+node build\.js x+...$/.test(l)), text);
    assert.ok(lines.every(l => l.length <= 140), 'a long command is cut');
  });

  test('execWarning treats a start time it cannot read as an unknown duration, not as NaN', () => {
    const text = execWarning('orch stop', [execRun({ startedAt: 'garbage' })], NOW);

    assert.doesNotMatch(text, /NaN/);
    assert.match(text, /running for \?\?/);
  });
});
