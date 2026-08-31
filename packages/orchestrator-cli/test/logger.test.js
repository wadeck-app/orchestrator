'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { DailyLogger } = require('../src/logger');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logger-test-'));
}

describe('DailyLogger', () => {
  test('write() creates a log file', () => {
    const dir = tmpDir();
    const log = new DailyLogger(dir, 'test');
    log.write('hello');
    log.close();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    assert.equal(files.length, 1, 'exactly one log file created');
  });

  test('write() content appears in log file', () => {
    const dir = tmpDir();
    const log = new DailyLogger(dir, 'test');
    log.write('hello world');
    log.close();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(content.includes('hello world'), 'log file must contain written text');
  });

  test('write() includes a timestamp prefix', () => {
    const dir = tmpDir();
    const log = new DailyLogger(dir, 'test');
    log.write('timestamped');
    log.close();
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
    const content = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    assert.ok(/^\[\d{4}-\d{2}-\d{2}/.test(content), 'log line must start with [YYYY-MM-DD');
  });

  test('close() is idempotent (no error on double close)', () => {
    const dir = tmpDir();
    const log = new DailyLogger(dir, 'test');
    log.write('test');
    log.close();
    assert.doesNotThrow(() => log.close());
  });

  test('old files beyond MAX_KEEP_DAYS are pruned', () => {
    const dir = tmpDir();
    // Create fake old log files
    const oldDate = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 10);
    const oldFile = path.join(dir, `prunetest-${oldDate}.log`);
    // Also create enough recent files to trigger pruning (need > MAX_KEEP_DAYS files)
    for (let i = 0; i < 31; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      fs.writeFileSync(path.join(dir, `prunetest-${d}.log`), 'x');
    }
    fs.writeFileSync(oldFile, 'old content');
    // Instantiate logger which calls _prune()
    const log = new DailyLogger(dir, 'prunetest');
    log.close();
    assert.ok(!fs.existsSync(oldFile), 'old log file should be pruned');
  });

  test('prefix isolation: only files matching prefix are managed', () => {
    const dir = tmpDir();
    const otherFile = path.join(dir, 'other-2020-01-01.log');
    fs.writeFileSync(otherFile, 'other');
    const log = new DailyLogger(dir, 'myprefix');
    log.write('test');
    log.close();
    assert.ok(fs.existsSync(otherFile), 'files with different prefix must not be touched');
  });
});
