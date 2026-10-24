'use strict';

// Edges of the progress lines of `orch status`: the low-confidence mark, the rounding, what is kept off a script's
// output, the order of several jobs, and that asking for progress never starts a daemon.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli, describeProgress } = require('../src/cli');

const dirs = [];
afterEach(() => {
  process.exitCode = 0;
  while (dirs.length > 0) {
    try { fs.rmSync(dirs.pop(), { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function run(argv, handlers, { tty = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-progress-edges-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
  const out = [];
  const err = [];
  const calls = [];
  const origLog = console.log;
  const origErr = console.error;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  const send = async (command, payload, opts) => {
    calls.push({ command, payload, opts });
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
  return { out: out.join('\n'), err: err.join('\n'), calls };
}

const INFO = {
  version: '1.2.3', pid: 4242, port: 47900, startedAt: '2026-10-18T08:00:00.000Z', uptimeSeconds: 12,
  config: {},
  supervisor: { requested: true, active: true },
  runs: { running: 3, supervised: 2, followedAgain: 1 },
  scheduler: { armed: 5, desired: 5, problems: [] },
};
const VERSION = { pid: 4242, port: 47900, uptime: 12, version: '1.2.3' };
const ETA = '2026-10-20T14:32:00.000Z';

function estimate(over) {
  return {
    strategyId: 'history', progress: 0.42, etaAt: ETA, confidence: 'high', confidenceScore: 0.9,
    reason: 'auto: history', serverNow: '2026-10-20T14:00:00.000Z', ...over,
  };
}

describe('describeProgress', () => {
  test('marks only a low-confidence estimate', () => {
    assert.match(describeProgress({ a: estimate({ confidence: 'low' }) })[0], / \(low confidence\)$/);
    assert.doesNotMatch(describeProgress({ a: estimate({ confidence: 'medium' }) })[0], /confidence/);
    assert.doesNotMatch(describeProgress({ a: estimate({ confidence: 'high' }) })[0], /confidence/);
  });

  test('rounds to the nearest percent, never up to a value the run has not reached', () => {
    assert.match(describeProgress({ a: estimate({ progress: 0.994 }) })[0], /: 99% ~/);
    assert.match(describeProgress({ a: estimate({ progress: 0.0049 }) })[0], /: 0% ~/);
    assert.match(describeProgress({ a: estimate({ progress: 0.006 }) })[0], /: 1% ~/);
    assert.match(describeProgress({ a: estimate({ progress: 0 }) })[0], /: 0% ~/);
  });

  test('keeps the order of the jobs it was given', () => {
    const lines = describeProgress({ zeta: estimate({}), alpha: estimate({}), mid: estimate({ progress: null, etaAt: null, confidence: 'none', reason: 'why' }) });
    assert.deepEqual(lines.map(l => l.trim().split(':')[0]), ['zeta', 'alpha', 'mid']);
  });

  test('a job with no estimate shows the reason, whatever the confidence field says', () => {
    assert.equal(describeProgress({ a: estimate({ progress: null, etaAt: null, confidence: 'none', reason: 'needs 3 usable runs, has 1' }) })[0],
      '  a: no estimate - needs 3 usable runs, has 1');
  });

  test('an overdue estimate prints the percent and the reason, not a time', () => {
    assert.equal(describeProgress({ a: estimate({ progress: 0.99, etaAt: null, reason: 'longer than usual (usual: 10 min)' }) })[0],
      '  a: 99% longer than usual (usual: 10 min)');
  });

  test('nothing running prints nothing', () => {
    assert.deepEqual(describeProgress({}), []);
  });
});

describe('orch status: progress in the output', () => {
  test('several running jobs are listed in the order the daemon answered', async () => {
    const { out } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO,
      'get-progress': { zeta: estimate({}), alpha: estimate({ progress: 0.1 }) },
    });
    assert.ok(out.indexOf('zeta') !== -1 && out.indexOf('zeta') < out.indexOf('alpha'), out);
  });

  test('asks for progress without starting a daemon', async () => {
    const { calls } = await run(['status'], { version: VERSION, 'get-daemon-info': INFO, 'get-progress': {} });
    const asked = calls.filter(c => c.command === 'get-progress');
    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].opts, { autoStart: false });
  });

  test('--json keeps the failure out of stderr and says it in the body', async () => {
    const { out, err } = await run(['status', '--json'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': new Error('Unknown command: get-progress'),
    });
    assert.equal(err, '');
    const body = JSON.parse(out);
    assert.equal(body.progressError, 'Unknown command: get-progress');
    assert.equal('progress' in body, false);
  });

  test('piped output (not a terminal) is JSON too: the failure stays out of stderr', async () => {
    const { out, err } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': new Error('boom'),
    }, { tty: false });
    assert.equal(err, '');
    assert.equal(JSON.parse(out).progressError, 'boom');
  });

  test('a good answer carries no progressError', async () => {
    const { out } = await run(['status', '--json'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': { a: estimate({}) },
    }, { tty: false });
    assert.equal('progressError' in JSON.parse(out), false);
  });

  test('on a terminal a failure is a warning on stderr and not a line of the status', async () => {
    const { out, err } = await run(['status'], {
      version: VERSION, 'get-daemon-info': INFO, 'get-progress': new Error('boom'),
    });
    assert.doesNotMatch(out, /boom/);
    assert.doesNotMatch(out, /progress/);
    assert.match(err, /^warning: could not read the progress of the running jobs \(boom\)/);
  });
});
