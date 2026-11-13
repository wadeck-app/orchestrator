'use strict';

// The real thing, on the machine that runs the tests: both Windows backends read the same process table, find this
// very process with its parent and a plausible memory, and leave no process behind. Other platforms read /proc or
// run `ps` (pidtree, pidusage) and have no table of their own: the tests say so instead of passing silently.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ProcessTable, createWindowsReader, wmicInstalled, monitoringInfo } = require('../src/process-table');

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
  test('ORCH_PROCESS_TABLE=powershell makes a machine with WMIC read through PowerShell', { skip }, () => {
    const before = process.env.ORCH_PROCESS_TABLE;
    process.env.ORCH_PROCESS_TABLE = 'powershell';
    try {
      assert.equal(wmicInstalled(), false);
      assert.equal(createWindowsReader().backend(), 'powershell');
    } finally {
      if (before === undefined) { delete process.env.ORCH_PROCESS_TABLE; } else { process.env.ORCH_PROCESS_TABLE = before; }
    }
  });

  test('PowerShell backend', { skip, timeout: 90_000 }, async () => {
    await checkBackend(createWindowsReader({ hasWmic: () => false }));
  });

  test('wmic backend (when the machine has it)', { skip: skip || (wmicInstalled() ? false : 'WMIC.exe is not installed on this machine (Windows 11 24H2+)'), timeout: 90_000 }, async () => {
    await checkBackend(createWindowsReader({ hasWmic: () => true }));
  });
});

// Finding the supervised runs again at daemon start asked pidusage, which on a Windows without WMIC is a PowerShell with no time
// limit. It now reads the same shared table as the monitoring.
describe('when a process started, for real', () => {
  const { processStartsOf, processStartOf } = require('../src/supervised-run');
  const expected = Date.now() - process.uptime() * 1000;

  for (const backend of ['default', 'powershell']) {
    test(`processStartsOf finds this process, and no other that is not running (${backend})`, { skip, timeout: 90_000 }, async () => {
      const before = process.env.ORCH_PROCESS_TABLE;
      if (backend === 'powershell') { process.env.ORCH_PROCESS_TABLE = 'powershell'; }
      try {
        const queriesBefore = monitoringInfo().queries;
        const starts = await processStartsOf([process.pid, 2_147_000_000]);
        assert.ok(monitoringInfo().queries > queriesBefore || backend === 'powershell', 'it did not read the shared process table');
        assert.deepEqual([...starts.keys()], [process.pid]);
        assert.ok(Math.abs(starts.get(process.pid) - expected) < 5_000, `started ${starts.get(process.pid)}, expected about ${expected}`);
        assert.ok(Math.abs((await processStartOf(process.pid)) - expected) < 5_000);
        assert.equal(await processStartOf(2_147_000_000), null);
      } finally {
        if (before === undefined) { delete process.env.ORCH_PROCESS_TABLE; } else { process.env.ORCH_PROCESS_TABLE = before; }
      }
    });
  }
});
