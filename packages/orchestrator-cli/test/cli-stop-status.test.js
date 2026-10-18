'use strict';

// `orch status` and `orch stop` on a daemon that may or may not be there, and what `stop` does about jobs.
//
// status used to start the daemon when it was down (every command that needs the daemon does), so asking "is it
// running?" answered "yes" by making it so. A daemon that is stopped must be reported as stopped.
//
// stop used to be the end of the jobs it had started. Supervised jobs now outlive the daemon, so stopping the
// daemon says which ones keep running, and `--kill-jobs` ends them first.
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

/** A config dir that looks like a running daemon's (a port file), or like a stopped one's (none). */
function configDir({ running }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-stop-'));
  dirs.push(dir);
  if (running) {
    fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
  }
  return dir;
}

async function run(argv, deps, { tty = false } = {}) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    await runCli(argv, deps);
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

describe('orch status', () => {
  test('on a stopped daemon says so, exits non-zero, and starts nothing', async () => {
    const down = Object.assign(new Error('Orchestrator is not running'), { code: 'ECONNREFUSED' });
    let started = 0;
    const { send, calls } = recorder({ version: () => { throw down; } });

    const { out } = await run(['status'], { send, startDaemon: () => { started++; }, configDir: configDir({ running: false }) }, { tty: true });

    assert.match(out, /not running/i);
    assert.equal(process.exitCode, 1);
    assert.equal(started, 0, 'status started the daemon');
    assert.equal(calls[0].options?.autoStart, false, 'status asked the transport to start the daemon for it');
  });

  test('on a stopped daemon with --json answers {"running":false}, so a script can tell', async () => {
    const down = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const { send } = recorder({ version: () => { throw down; } });

    const { out } = await run(['status', '--json'], { send, startDaemon: () => {}, configDir: configDir({ running: false }) });

    assert.deepEqual(JSON.parse(out), { running: false });
    assert.equal(process.exitCode, 1);
  });

  test('on a running daemon still prints its pid, port and uptime, and exits zero', async () => {
    const { send } = recorder({ version: { pid: 4242, port: 47900, uptime: 12, version: 'x' } });

    const { out } = await run(['status'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) }, { tty: true });

    assert.match(out, /pid=4242\s+port=47900\s+uptime=12s/);
    assert.equal(process.exitCode ?? 0, 0);
  });

  test('a daemon that is there but fails for another reason is not reported as stopped', async () => {
    const { send } = recorder({ version: () => { throw new Error('internal failure: state file unreadable'); } });

    const { err, out } = await run(['status'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) }, { tty: true });

    assert.doesNotMatch(out, /not running/i);
    assert.match(err, /state file unreadable/);
    assert.equal(process.exitCode, 1);
  });
});

const RUNNING_SUPERVISED = {
  server: [{ startedAt: '2026-10-18T10:00:00.000Z', exitCode: null, pid: 1, supervised: true }],
  scraper: [{ startedAt: '2026-10-18T10:00:00.000Z', exitCode: null, pid: 2, supervised: true }],
  done: [{ startedAt: '2026-10-18T09:00:00.000Z', finishedAt: '2026-10-18T09:01:00.000Z', exitCode: 0, pid: 3, supervised: true }],
  plain: [{ startedAt: '2026-10-18T10:00:00.000Z', exitCode: null, pid: 4 }],
};

describe('orch stop', () => {
  test('says which supervised jobs keep running, and how to end them', async () => {
    const { send, calls } = recorder({ 'list-state': RUNNING_SUPERVISED });

    const { out } = await run(['stop'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) });

    assert.match(out, /Orchestrator stopped\./);
    assert.match(out, /2 job\(s\) keep running/);
    assert.match(out, /server/);
    assert.match(out, /scraper/);
    assert.doesNotMatch(out, /done|plain/, 'a finished job and an unsupervised one do not keep running');
    assert.match(out, /orch stop --kill-jobs/);
    assert.deepEqual(calls.filter((c) => c.command === 'kill-job'), [], 'a plain stop must not end any job');
    assert.ok(calls.some((c) => c.command === 'quit'));
  });

  test('says nothing about jobs when none keeps running', async () => {
    const { send } = recorder({ 'list-state': { done: RUNNING_SUPERVISED.done } });

    const { out } = await run(['stop'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) });

    assert.equal(out.trim(), 'Orchestrator stopped.');
  });

  test('--kill-jobs ends every running job first, then stops the daemon', async () => {
    const { send, calls } = recorder({ 'list-state': RUNNING_SUPERVISED, 'kill-job': { killed: true, count: 1 } });

    const { out } = await run(['stop', '--kill-jobs'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) });

    const order = calls.map((c) => c.command);
    assert.deepEqual(calls.filter((c) => c.command === 'kill-job').map((c) => c.payload.id).sort(), ['plain', 'scraper', 'server']);
    assert.ok(order.lastIndexOf('kill-job') < order.indexOf('quit'), `the daemon was stopped before the jobs were ended: ${order.join(', ')}`);
    assert.match(out, /3 job\(s\) ended/);
    assert.match(out, /Orchestrator stopped\./);
    assert.doesNotMatch(out, /keep running/);
  });

  test('--kill-jobs says which job it could not end, and still stops the daemon', async () => {
    const { send, calls } = recorder({
      'list-state': RUNNING_SUPERVISED,
      'kill-job': (p) => { if (p.id === 'server') { throw new Error('refused'); } return { killed: true, count: 1 }; },
    });

    const { out, err } = await run(['stop', '--kill-jobs'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) });

    assert.match(err, /server/);
    assert.match(err, /refused/);
    assert.match(out, /Orchestrator stopped\./);
    assert.ok(calls.some((c) => c.command === 'quit'));
  });

  test('a daemon that cannot list its jobs is still stopped, and the user is told the list is unknown', async () => {
    const { send, calls } = recorder({ 'list-state': () => { throw new Error('boom'); } });

    const { out, err } = await run(['stop'], { send, startDaemon: () => {}, configDir: configDir({ running: true }) });

    assert.match(out, /Orchestrator stopped\./);
    assert.match(err, /could not list the running jobs.*boom/);
    assert.ok(calls.some((c) => c.command === 'quit'));
  });

  test('on a stopped daemon says so and sends nothing', async () => {
    const { send, calls } = recorder({});

    const { out } = await run(['stop'], { send, startDaemon: () => {}, configDir: configDir({ running: false }) });

    assert.match(out, /not running/i);
    assert.deepEqual(calls, []);
  });
});
