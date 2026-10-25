'use strict';

// `orch status` on a daemon that died of an uncaught error says so, with when, why and where to look, instead of the
// bare "not running" that hid a 47-minute outage on 2026-10-25. The daemon leaves crashed.json when it dies that way and
// removes it at its next start.
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

function stoppedConfigDir(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-crashed-'));
  dirs.push(dir);
  if (marker !== undefined) {
    fs.writeFileSync(path.join(dir, 'crashed.json'), typeof marker === 'string' ? marker : JSON.stringify(marker));
  }
  return dir;
}

async function run(argv, configDir, { tty }) {
  const out = [];
  const err = [];
  const origLog = console.log;
  const origErr = console.error;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  const down = Object.assign(new Error('Orchestrator is not running'), { code: 'ECONNREFUSED' });
  try {
    await runCli(argv, { send: async () => { throw down; }, startDaemon: () => {}, configDir });
  } finally {
    console.log = origLog;
    console.error = origErr;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
  }
  return { out: out.join('\n'), err: err.join('\n') };
}

const MARKER = {
  time: '2026-10-24T22:47:38.000Z', kind: 'uncaughtException', error: 'something broke', version: '2026.10.24-514', pid: 64668,
};

describe('orch status on a daemon that crashed', () => {
  test('says stopped: crashed, with when, why, the log to read and the way back', async () => {
    const dir = stoppedConfigDir(MARKER);
    const { out } = await run(['status'], dir, { tty: true });
    assert.match(out, /stopped: crashed/);
    assert.match(out, /2026-10-24T22:47:38/);
    assert.match(out, /uncaughtException/);
    assert.match(out, /something broke/);
    assert.ok(out.includes(path.join(dir, 'logs')), `no log path in: ${out}`);
    assert.match(out, /orch start/);
    assert.equal(process.exitCode, 1);
  });

  test('--json carries the marker, so a script can tell a crash from a stop', async () => {
    const dir = stoppedConfigDir(MARKER);
    const { out } = await run(['status', '--json'], dir, { tty: false });
    assert.deepEqual(JSON.parse(out), { running: false, crashed: MARKER });
  });

  test('without a marker it is the plain stopped message', async () => {
    const dir = stoppedConfigDir();
    const { out } = await run(['status'], dir, { tty: true });
    assert.match(out, /not running/i);
    assert.doesNotMatch(out, /crashed/);
  });

  test('a marker that cannot be parsed is reported with the file to delete, and the daemon is still reported stopped', async () => {
    const dir = stoppedConfigDir('{broken');
    const { out, err } = await run(['status'], dir, { tty: true });
    assert.match(out, /not running/i);
    assert.match(err, /crashed\.json/);
    assert.match(err, /delete/);
  });
});
