'use strict';

// `orch stop`, `orch restart` and `orch cli update` end the daemon; with no supervisor, the running jobs die
// with it. Each says so BEFORE acting (warn, never ask: scripts must not block), naming the jobs and the way out.
// `orch status` shows the supervisor state (also covered in cli-status-details.test.js).
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');

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
async function run(argv, { info, state = STATE, platform = 'linux', infoError, updateRuns } = {}) {
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
    test('warns before acting, names the unsupervised running jobs, says they are killed, and says Linux has no way out', async () => {
      const { events, err } = await run(argv, { info: INFO_UNAVAILABLE });

      assert.match(err, /warning/i);
      assert.match(err, /2 running job\(s\)/);
      assert.match(err, /server, scraper/);
      assert.doesNotMatch(err, /guarded|done/, 'a supervised job survives and a finished one is not running');
      assert.match(err, /killed with the daemon/);
      assert.match(err, /no supervisor executable for linux-arm64/, 'the daemon\'s own reason is repeated');
      assert.match(err, /Linux/);
      assert.match(err, /source checkout/);
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
