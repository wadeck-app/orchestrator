'use strict';

const { test, describe, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { EventPublisher } = require('../src/event-publisher');

/*
 * The queue daemon stops itself when idle, and only the `queue` CLI starts it (`queue push` wakes it, then pushes).
 * When the daemon is down (no config.port, or connection refused) the publisher falls back to that CLI. A 401 or any
 * other HTTP answer is a real answer from a live daemon: no fallback. The CLI here is a fake on a temp PATH entry.
 */

const CWD = path.resolve(os.tmpdir(), 'orch-fallback-cwd');
const dirs = [];
const originalPath = process.env.PATH;
const originalRecord = process.env.FAKE_QUEUE_RECORD;
const originalCliSwitch = process.env.ORCH_QUEUE_CLI;

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

// A `queue` on PATH laid out like the npm shim: queue.cmd pointing at node_modules/.../queue.js on Windows, an
// executable script elsewhere. The script appends {argv, cwd} to $FAKE_QUEUE_RECORD and exits with `exitCode`.
function installFakeCli(binDir, { exitCode = 0 } = {}) {
  const js = [
    "require('node:fs').appendFileSync(process.env.FAKE_QUEUE_RECORD, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
    `process.exit(${exitCode});`,
    '',
  ].join('\n');
  if (process.platform === 'win32') {
    const script = path.join(binDir, 'node_modules', '@wadeck-app', 'queue-cli', 'bin', 'queue.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, js);
    fs.writeFileSync(path.join(binDir, 'queue.cmd'), [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', ')', '',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@wadeck-app\\queue-cli\\bin\\queue.js" %*',
      '',
    ].join('\r\n'));
  } else {
    fs.writeFileSync(path.join(binDir, 'queue'), `#!${process.execPath}\n${js}`, { mode: 0o755 });
  }
}

function setup(opts) {
  const bin = tmp('orch-fake-bin-');
  installFakeCli(bin, opts);
  const record = path.join(tmp('orch-fake-rec-'), 'calls.ndjson');
  process.env.FAKE_QUEUE_RECORD = record;
  delete process.env.ORCH_QUEUE_CLI;
  process.env.PATH = bin + path.delimiter + originalPath;
  const calls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { calls };
}

function makeLog() {
  const lines = [];
  return { lines, write: (l) => lines.push(l) };
}

async function until(pred, what, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

function emptyQueueDir() { return tmp('orch-queue-down-'); }

async function refusedPortDir() {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const dir = tmp('orch-queue-refused-');
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ sdkVersion: 1, port, pid: process.pid }));
  fs.writeFileSync(path.join(dir, 'health_token'), 'tok');
  return dir;
}

beforeEach(() => { process.env.PATH = originalPath; fs.mkdirSync(CWD, { recursive: true }); });
afterEach(() => {
  process.env.PATH = originalPath;
  if (originalCliSwitch === undefined) { delete process.env.ORCH_QUEUE_CLI; } else { process.env.ORCH_QUEUE_CLI = originalCliSwitch; }
  if (originalRecord === undefined) { delete process.env.FAKE_QUEUE_RECORD; } else { process.env.FAKE_QUEUE_RECORD = originalRecord; }
});
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(CWD, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('EventPublisher: fallback to the queue CLI when the daemon is down', () => {
  test('no config.port: runs `queue push <event> <json>` with the cwd the HTTP path would send', async () => {
    const env = setup();
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: emptyQueueDir(), cwd: CWD })
      .publish('job.started', { jobId: 'a', label: 'A' });
    await until(() => env.calls().length === 1, 'the CLI call');
    const call = env.calls()[0];
    assert.deepEqual(call.argv, ['push', 'job.started', JSON.stringify({ jobId: 'a', label: 'A' })]);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(CWD));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(log.lines, [], 'a delivered event is not a failure');
  });

  test('connection refused: same fallback', async () => {
    const env = setup();
    new EventPublisher('orchestrator', makeLog(), { queueConfigDir: await refusedPortDir(), cwd: CWD })
      .publish('job.completed', { jobId: 'a' });
    await until(() => env.calls().length === 1, 'the CLI call');
    assert.equal(env.calls()[0].argv[1], 'job.completed');
  });

  test('a 401 is a real answer: the CLI is not run', async () => {
    const env = setup();
    const server = http.createServer((req, res) => { res.writeHead(401); res.end('{"error":"Unauthorized"}'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const dir = tmp('orch-queue-401-');
    fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ sdkVersion: 1, port: server.address().port, pid: 1 }));
    fs.writeFileSync(path.join(dir, 'health_token'), 'tok');
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: dir, cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    await new Promise((r) => setTimeout(r, 300));
    await new Promise((r) => server.close(r));
    assert.equal(env.calls().length, 0);
    assert.match(log.lines[0], /401/);
  });

  test('CLI not on PATH: one explicit line per streak', async () => {
    delete process.env.ORCH_QUEUE_CLI;
    process.env.PATH = tmp('orch-empty-bin-');
    const log = makeLog();
    const pub = new EventPublisher('orchestrator', log, { queueConfigDir: emptyQueueDir(), cwd: CWD });
    pub.publish('job.started', { jobId: 'a' });
    pub.publish('job.completed', { jobId: 'a' });
    await until(() => log.lines.length >= 1, 'the failure line');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(log.lines.length, 1, JSON.stringify(log.lines));
    assert.match(log.lines[0], /queue daemon not running and the queue CLI was not found on PATH: events are lost; install queue or start its daemon/);
  });

  test('a CLI that exits non-zero is a logged failure', async () => {
    setup({ exitCode: 3 });
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: emptyQueueDir(), cwd: CWD }).publish('job.started', { jobId: 'a' });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.match(log.lines[0], /exit/i);
    assert.match(log.lines[0], /3/);
  });

  test('a payload too long for a command line is reported, not truncated or sent', async () => {
    const env = setup();
    const log = makeLog();
    new EventPublisher('orchestrator', log, { queueConfigDir: emptyQueueDir(), cwd: CWD })
      .publish('job.failed', { jobId: 'a', blob: 'x'.repeat(20000) });
    await until(() => log.lines.length === 1, 'the failure line');
    assert.match(log.lines[0], /too long|limit/i);
    assert.match(log.lines[0], /\d{4,}/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(env.calls().length, 0);
  });

  test('a burst is bounded: oldest dropped, ONE line says how many', async () => {
    const env = setup();
    const log = makeLog();
    const pub = new EventPublisher('orchestrator', log, {
      queueConfigDir: emptyQueueDir(), cwd: CWD,
      fallback: { intervalMs: 60_000, maxConcurrent: 4, bufferSize: 50 },
    });
    // The first is spawned at once; the next 50 fill the buffer; the last 20 each push the oldest out.
    for (let i = 0; i < 71; i++) { pub.publish('job.started', { jobId: `j${i}` }); }
    await until(() => log.lines.some((l) => /dropped/i.test(l)), 'the drop line');
    await new Promise((r) => setTimeout(r, 300));
    const drops = log.lines.filter((l) => /dropped/i.test(l));
    assert.equal(drops.length, 1, JSON.stringify(log.lines));
    assert.match(drops[0], /\b20\b/);
    await until(() => env.calls().length >= 1, 'first spawn');
    assert.equal(env.calls().length, 1, 'sustained rate is one spawn per interval');
  });

  test('publish never throws and returns without waiting for the CLI', () => {
    setup();
    const pub = new EventPublisher('orchestrator', makeLog(), { queueConfigDir: emptyQueueDir(), cwd: CWD });
    const t0 = Date.now();
    assert.doesNotThrow(() => pub.publish('job.started', { jobId: 'a' }));
    assert.ok(Date.now() - t0 < 100);
  });
});
