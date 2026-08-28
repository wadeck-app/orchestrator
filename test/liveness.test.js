'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { checkLiveness } = require('../src/liveness');

function tmpFile() {
  return path.join(os.tmpdir(), `orch-liveness-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// pidFile strategy needs a configurable base dir
const ORCH_CONFIG_DIR = path.join(os.tmpdir(), `orch-liveness-config-${Date.now()}`);
process.env.ORCH_CONFIG_DIR = ORCH_CONFIG_DIR;

describe('none / null strategy', () => {
  test('null liveness returns false', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: null }), false);
  });

  test('strategy:none returns false', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'none' } }), false);
  });
});

describe('portFile strategy', () => {
  test('returns true when port file contains alive PID', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ pid: process.pid }));
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), true);
    fs.unlinkSync(f);
  });

  test('returns false when port file contains dead PID', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, JSON.stringify({ pid: 999999999 }));
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), false);
    fs.unlinkSync(f);
  });

  test('returns false when port file is absent', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: '/no/such/file.json' } }), false);
  });

  test('returns false when port file is malformed JSON', async () => {
    const f = tmpFile();
    fs.writeFileSync(f, 'not-json');
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: f } }), false);
    fs.unlinkSync(f);
  });

  test('expands tilde in portFile path', async () => {
    // Just confirm it does not throw and returns false (no file at that path)
    const result = await checkLiveness({ id: 'x', liveness: { strategy: 'portFile', portFile: '~/no-such-file.json' } });
    assert.equal(result, false);
  });
});

describe('pidFile strategy', () => {
  test('returns true when pid file contains alive PID', async () => {
    const pidsDir = path.join(ORCH_CONFIG_DIR, 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, 'my-job.pid'), String(process.pid));
    assert.equal(await checkLiveness({ id: 'my-job', liveness: { strategy: 'pidFile' } }), true);
  });

  test('returns false when pid file is absent', async () => {
    assert.equal(await checkLiveness({ id: 'no-such-job', liveness: { strategy: 'pidFile' } }), false);
  });

  test('returns false when pid file contains dead PID', async () => {
    const pidsDir = path.join(ORCH_CONFIG_DIR, 'pids');
    fs.mkdirSync(pidsDir, { recursive: true });
    fs.writeFileSync(path.join(pidsDir, 'dead-job.pid'), '999999999');
    assert.equal(await checkLiveness({ id: 'dead-job', liveness: { strategy: 'pidFile' } }), false);
  });
});

describe('command strategy', () => {
  test('returns true when command exits 0', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'node -e "process.exit(0)"' } }), true);
  });

  test('returns false when command exits non-zero', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'node -e "process.exit(1)"' } }), false);
  });

  test('returns false when command does not exist', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'command', command: 'no-such-binary-xyz-12345' } }), false);
  });
});

describe('unknown strategy', () => {
  test('returns false without throwing', async () => {
    assert.equal(await checkLiveness({ id: 'x', liveness: { strategy: 'magic' } }), false);
  });
});
