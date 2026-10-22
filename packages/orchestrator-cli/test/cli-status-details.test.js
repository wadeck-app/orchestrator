'use strict';

// `orch status` and `orch timers` used to show what the daemon answers to `version` and to `list-timers` and
// nothing of what get-daemon-info already knows: whether jobs run under a supervisor (and why not), how many runs
// are alive, and which timers the scheduler could not arm. A user had to open the dashboard, or read the daemon
// log, to learn that the supervisor was unavailable or that a job would never fire.
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

function configDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-details-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
  return dir;
}

async function run(argv, send, { tty = false } = {}) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    await runCli(argv, { send, startDaemon: () => {}, configDir: configDir() });
  } finally {
    console.log = origLog;
    console.error = origErr;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

function recorder(handlers) {
  const calls = [];
  const send = async (command, payload, options) => {
    calls.push({ command, payload, options });
    const handler = handlers[command];
    if (handler === undefined) {
      return {};
    }
    return typeof handler === 'function' ? handler(payload) : handler;
  };
  return { calls, send };
}

const INFO = {
  version: '1.2.3', pid: 4242, port: 47900, startedAt: '2026-10-18T08:00:00.000Z', uptimeSeconds: 12,
  config: {},
  supervisor: { requested: true, active: true },
  runs: { running: 3, supervised: 2, followedAgain: 1 },
  scheduler: { armed: 5, desired: 5, problems: [] },
};

describe('orch status: the daemon details', () => {
  const up = (info) => recorder({ version: { pid: 4242, port: 47900, uptime: 12, version: '1.2.3' }, 'get-daemon-info': info });

  test('says the version, the run counts and that jobs run under a supervisor', async () => {
    const { send } = up(INFO);

    const { out } = await run(['status'], send, { tty: true });

    assert.match(out, /pid=4242\s+port=47900\s+uptime=12s/, 'the first line is unchanged');
    assert.match(out, /version\s*:?\s*1\.2\.3/);
    assert.match(out, /3 running \(2 supervised\)/);
    assert.match(out, /supervisor\s*:?\s*on/i);
    assert.match(out, /timers\s*:?\s*5 armed of 5/i);
  });

  test('says the supervisor is off when supervisedJobs is off', async () => {
    const { send } = up({ ...INFO, supervisor: { requested: false, active: false } });

    const { out } = await run(['status'], send, { tty: true });

    assert.match(out, /supervisor\s*:?\s*off/i);
  });

  test('says it was requested and is unavailable, with the daemon note and its fix', async () => {
    const note = 'supervisedJobs is on (the default), but the supervisor was not found. Reinstall with: orch cli update';
    const { send } = up({ ...INFO, supervisor: { requested: true, active: false, note } });

    const { out } = await run(['status'], send, { tty: true });

    assert.match(out, /supervisor\s*:?\s*requested but UNAVAILABLE/);
    assert.ok(out.includes(note), `the note is missing: ${out}`);
  });

  test('lists the timer problems by job and says where to look next', async () => {
    const { send } = up({ ...INFO, scheduler: { armed: 3, desired: 5, problems: [
      { jobId: 'nightly', problem: 'enabled cron job with no timer armed' },
      { jobId: 'sync', problem: 'timer armed for a job that is off' },
    ] } });

    const { out } = await run(['status'], send, { tty: true });

    assert.match(out, /timers\s*:?\s*3 armed of 5/i);
    assert.match(out, /2 timer problem/i);
    assert.match(out, /nightly.*enabled cron job with no timer armed/);
    assert.match(out, /sync.*timer armed for a job that is off/);
    assert.match(out, /orch timers/);
  });

  test('exits zero even with timer problems or an unavailable supervisor, as before', async () => {
    const { send } = up({ ...INFO, supervisor: { requested: true, active: false, note: 'n' }, scheduler: { armed: 0, desired: 1, problems: [{ jobId: 'a', problem: 'p' }] } });

    await run(['status'], send, { tty: true });

    assert.equal(process.exitCode ?? 0, 0);
  });

  test('--json keeps every existing field and adds the details under info', async () => {
    const { send } = up(INFO);

    const { out } = await run(['status', '--json'], send);

    const parsed = JSON.parse(out);
    assert.equal(parsed.pid, 4242);
    assert.equal(parsed.port, 47900);
    assert.equal(parsed.uptime, 12);
    assert.deepEqual(parsed.info, INFO);
  });

  test('a daemon that cannot give its details still reports pid/port/uptime, warns, and names the cause', async () => {
    const { send } = up(() => { throw new Error('Unknown command: get-daemon-info'); });

    const { out, err } = await run(['status'], send, { tty: true });

    assert.match(out, /pid=4242\s+port=47900\s+uptime=12s/);
    assert.match(err, /could not read the daemon details.*Unknown command: get-daemon-info/i);
    assert.match(err, /orch restart|orch cli update/, 'it says what to do');
    assert.equal(process.exitCode ?? 0, 0);
  });

  test('--json carries the failure as infoError instead of dropping the details silently', async () => {
    const { send } = up(() => { throw new Error('boom'); });

    const { out } = await run(['status', '--json'], send);

    const parsed = JSON.parse(out);
    assert.equal(parsed.pid, 4242);
    assert.equal(parsed.info, undefined);
    assert.match(parsed.infoError, /boom/);
  });

  test('asks for the details without starting the daemon', async () => {
    const { send, calls } = up(INFO);

    await run(['status'], send, { tty: true });

    assert.equal(calls.find((c) => c.command === 'get-daemon-info').options?.autoStart, false);
  });
});

describe('orch timers: a warning when the scheduler reports problems', () => {
  const ROW = { type: 'cron', enabled: true, armed: 'cron', dueAt: null, windowEndsAt: null, nextFiring: null, windowState: null, spent: false };
  const GOOD = { ...ROW, jobId: 'ok', problem: null };
  const BAD = { ...ROW, jobId: 'nightly', armed: null, problem: 'enabled cron job with no timer armed' };

  test('prints one warning line naming the jobs, and keeps the table', async () => {
    const { send } = recorder({ 'list-timers': [GOOD, BAD] });

    const { out, err } = await run(['timers'], send, { tty: true });

    assert.match(err, /warning: 1 job\(s\) will not fire as configured: nightly/i);
    assert.match(out, /problem: enabled cron job with no timer armed/);
  });

  test('prints no warning when every timer is as configured', async () => {
    const { send } = recorder({ 'list-timers': [GOOD] });

    const { out, err } = await run(['timers'], send, { tty: true });

    assert.equal(err, '');
    assert.match(out, /armed as configured/);
  });

  test('piped, stdout stays the bare JSON array and the warning goes to stderr', async () => {
    const { send } = recorder({ 'list-timers': [GOOD, BAD] });

    const { out, err } = await run(['timers', '--json'], send);

    assert.deepEqual(JSON.parse(out), [GOOD, BAD]);
    assert.match(err, /warning: 1 job\(s\) will not fire as configured: nightly/i);
  });

  test('exits zero as before', async () => {
    const { send } = recorder({ 'list-timers': [BAD] });

    await run(['timers'], send, { tty: true });

    assert.equal(process.exitCode ?? 0, 0);
  });
});
