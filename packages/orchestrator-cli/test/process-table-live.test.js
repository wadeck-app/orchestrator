'use strict';

// The real thing, on the machine that runs the tests: both Windows backends read the same process table, find this
// very process with its parent and a plausible memory, and leave no process behind. Other platforms read /proc or
// run `ps` (pidtree, pidusage) and have no table of their own: the tests say so instead of passing silently.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ProcessTable, createWindowsReader, wmicInstalled } = require('../src/process-table');

const onWindows = process.platform === 'win32';
const skip = onWindows ? false : 'the process table is read by pidtree/pidusage on this platform (process-table.ts is Windows only)';

async function checkBackend(reader) {
  const table = new ProcessTable({ read: reader.read, now: Date.now, ttlMs: 0 });
  const usage = await table.usageMany([process.pid]);
  const me = usage[process.pid];
  assert.ok(me, `pid ${process.pid} is not in the table read through ${reader.backend()}`);
  assert.equal(me.ppid, process.ppid);
  assert.ok(me.memory > 10 * 1024 * 1024 && me.memory < 8 * 1024 ** 3, `memory ${me.memory}`);
  assert.ok(me.elapsed >= 0 && me.elapsed < 24 * 3600_000, `elapsed ${me.elapsed}`);
  assert.ok(me.cpu >= 0, `cpu ${me.cpu}`);
  assert.ok((await table.tree(process.ppid)).includes(process.pid), 'this process is not a descendant of its parent');
}

describe('the process table, for real', () => {
  test('PowerShell backend', { skip, timeout: 90_000 }, async () => {
    await checkBackend(createWindowsReader({ hasWmic: () => false }));
  });

  test('wmic backend (when the machine has it)', { skip: skip || (wmicInstalled() ? false : 'WMIC.exe is not installed on this machine (Windows 11 24H2+)'), timeout: 90_000 }, async () => {
    await checkBackend(createWindowsReader({ hasWmic: () => true }));
  });
});
