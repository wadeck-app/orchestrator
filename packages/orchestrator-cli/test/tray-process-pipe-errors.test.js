'use strict';

// A tray child that dies must never take the daemon down.
//
// Incident 2026-10-25: the Go tray exited, the daemon wrote to its closed stdin, the stream emitted 'error' (EPIPE) with
// no listener, and that became an uncaughtException: the daemon exited with code 1 and nothing restarted it. Every
// stream of the child is a source of such an event, so each one is driven here with an error and must not throw.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { TrayProcess } = require('../src/tray-process');

function errno(code, message) {
  return Object.assign(new Error(message ?? code), { code });
}

/** A child process by hand: three streams, a pid, and whatever the test wants to do to them. */
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 4242;
  child.killed = false;
  child.exitCode = null;
  child.killCalls = [];
  child.kill = (signal) => { child.killCalls.push(signal ?? 'SIGTERM'); child.killed = true; return true; };
  return child;
}

function makeTray(child) {
  return new TrayProcess('fake-tray', {}, () => child);
}

describe('TrayProcess: a stream error from the child is never an uncaught exception', () => {
  for (const streamName of ['stdin', 'stdout', 'stderr']) {
    test(`an EPIPE on the child's ${streamName} is absorbed`, () => {
      const child = makeFakeChild();
      makeTray(child);
      // EventEmitter throws an 'error' with no listener from inside emit(): that throw is the uncaughtException.
      assert.doesNotThrow(() => child[streamName].emit('error', errno('EPIPE', 'write EPIPE')));
    });
  }

  test('an error on the child process itself is absorbed', () => {
    const child = makeFakeChild();
    makeTray(child);
    assert.doesNotThrow(() => child.emit('error', errno('ENOENT', 'spawn fake-tray ENOENT')));
  });

  test('a stdin error is reported once, with the cause, to whoever listens', () => {
    const child = makeFakeChild();
    const tray = makeTray(child);
    const seen = [];
    tray.onStreamError((stream, err) => seen.push(`${stream}:${err.code}`));
    child.stdin.emit('error', errno('EPIPE'));
    child.stdin.emit('error', errno('EPIPE'));
    child.stdin.emit('error', errno('ERR_STREAM_DESTROYED'));
    assert.deepEqual(seen, ['stdin:EPIPE'], 'the same broken pipe must be one report, not one per write');
  });

  test('a stdin error on a child that is still alive ends it, so the manager restarts a tray that works', () => {
    const child = makeFakeChild();
    makeTray(child);
    child.stdin.emit('error', errno('EPIPE'));
    assert.equal(child.killCalls.length, 1, 'a tray whose stdin is broken can no longer be updated: it must be ended');
  });
});

describe('TrayProcess.send after the child is gone', () => {
  test('resolves false and does not throw when the write fails with EPIPE', async () => {
    const child = makeFakeChild();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(errno('EPIPE', 'write EPIPE')); } });
    const tray = makeTray(child);
    child.stdout.write('{"type":"ready"}\n');
    await tray.ready();
    assert.equal(await tray.send({ type: 'exit' }), false);
  });

  test('resolves false when stdin is already destroyed', async () => {
    const child = makeFakeChild();
    const tray = makeTray(child);
    child.stdout.write('{"type":"ready"}\n');
    await tray.ready();
    child.stdin.destroy();
    assert.equal(await tray.send({ type: 'exit' }), false);
  });

  test('resolves false once the process has exited, without touching stdin', async () => {
    const child = makeFakeChild();
    let writes = 0;
    child.stdin = new Writable({ write(_c, _e, cb) { writes++; cb(); } });
    const tray = makeTray(child);
    child.exitCode = 1;
    child.emit('exit', 1, null);
    assert.equal(await tray.send({ type: 'exit' }), false);
    assert.equal(writes, 0);
  });

  test('resolves true when the message was written', async () => {
    const child = makeFakeChild();
    const lines = [];
    child.stdin = new Writable({ write(chunk, _e, cb) { lines.push(chunk.toString()); cb(); } });
    const tray = makeTray(child);
    child.stdout.write('{"type":"ready"}\n');
    await tray.ready();
    assert.equal(await tray.send({ type: 'exit' }), true);
    assert.deepEqual(lines, ['{"type":"exit"}\n']);
  });

  test('a failed send is logged once per tray process, not once per message', async () => {
    const child = makeFakeChild();
    child.stdin = new Writable({ write(_c, _e, cb) { cb(errno('EPIPE', 'write EPIPE')); } });
    const tray = makeTray(child);
    const reports = [];
    tray.onSendFailed((reason) => reports.push(reason));
    child.stdout.write('{"type":"ready"}\n');
    await tray.ready();
    await tray.send({ type: 'set-menu', menu: {} });
    await tray.send({ type: 'set-menu', menu: {} });
    await tray.send({ type: 'set-menu', menu: {} });
    assert.equal(reports.length, 1);
    assert.match(reports[0], /EPIPE/);
  });

  test('writeNow reports false instead of throwing when stdin is gone', () => {
    const child = makeFakeChild();
    const tray = makeTray(child);
    child.stdin.destroy();
    assert.equal(tray.writeNow({ type: 'exit' }), false);
  });
});

describe('TrayProcess with a real child that exits at once', () => {
  test('writing to it after it died neither throws nor rejects', async () => {
    const script = path.join(__dirname, 'helpers', 'exit-now.js');
    const tray = new TrayProcess('unused', {}, (_bin, _args, options) => spawn(process.execPath, [script], options));
    await new Promise((resolve) => { tray.onExit(resolve); });
    // The streams are torn down after 'exit'; wait for 'close' of stdin so the write meets a broken pipe, not a live one.
    await new Promise((resolve) => setImmediate(resolve));
    const results = [];
    for (let i = 0; i < 5; i++) {
      results.push(await tray.send({ type: 'set-menu', menu: {} }));
    }
    assert.deepEqual(results, [false, false, false, false, false]);
  });
});
