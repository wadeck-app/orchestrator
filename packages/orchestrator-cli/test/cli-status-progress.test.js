'use strict';

// `orch status` prints the progress of each running job: "42% ~14:32", or the reason there is no estimate.
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

async function run(argv, handlers, { tty = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-progress-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  const send = async (command) => {
    const handler = handlers[command];
    if (handler === undefined) {
      return {};
    }
    if (handler instanceof Error) {
      throw handler;
    }
    return handler;
  };
  try {
    await runCli(argv, { send, startDaemon: () => {}, configDir: dir });
  } finally {
    console.log = origLog;
    console.error = origErr;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

const INFO = {
  version: '1.2.3', pid: 4242, port: 47900, startedAt: '2026-10-18T08:00:00.000Z', uptimeSeconds: 12,
  config: {},
  supervisor: { requested: true, active: true },
  runs: { running: 3, supervised: 2, followedAgain: 1 },
  scheduler: { armed: 5, desired: 5, problems: [] },
};
const VERSION = { pid: 4242, port: 47900, uptime: 12, version: '1.2.3' };

function estimate(over) {
  return {
    strategyId: 'history', progress: 0.42, etaAt: '2026-10-20T14:32:00.000Z', confidence: 'high', confidenceScore: 0.9,
    reason: 'auto: history', serverNow: '2026-10-20T14:00:00.000Z', ...over,
  };
}

function hhmm(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('orch status: progress of running jobs', () => {
  test('prints percent and local end time per running job', async () => {
    const { out } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO,
      'get-progress': { backup: estimate({}) },
    });
    assert.match(out, new RegExp(`backup\\s*:?\\s+42% ~${hhmm('2026-10-20T14:32:00.000Z')}`));
  });

  test('prints the reason when there is no estimate', async () => {
    const { out } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO,
      'get-progress': { backup: estimate({ progress: null, etaAt: null, confidence: 'none', reason: 'auto: history: needs 3 usable runs, has 1' }) },
    });
    assert.match(out, /backup.*needs 3 usable runs, has 1/);
  });

  test('prints the overdue reason instead of a time', async () => {
    const { out } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO,
      'get-progress': { backup: estimate({ progress: 0.99, etaAt: null, reason: 'longer than usual (usual: 10 min)' }) },
    });
    assert.match(out, /backup.*99%.*longer than usual \(usual: 10 min\)/);
  });

  test('prints nothing extra when no job runs', async () => {
    const { out } = await run(['status'], { version: VERSION, 'get-daemon-info': INFO, 'get-progress': {} });
    assert.doesNotMatch(out, /progress/i);
  });

  test('says in words that progress could not be read, with the fix', async () => {
    const { out, err } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': new Error('Unknown command: get-progress'),
    });
    assert.match(out, /pid=4242/);
    assert.match(err, /could not read the progress of the running jobs \(Unknown command: get-progress\)/);
    assert.match(err, /orch cli update/);
  });

  test('--json carries the progress object', async () => {
    const { out } = await run(['status', '--json'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': { backup: estimate({}) },
    }, { tty: false });
    assert.equal(JSON.parse(out).progress.backup.progress, 0.42);
  });
});
