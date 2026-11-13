'use strict';

// The daemon measures every running job's process tree. pidusage/pidtree start one process per measurement (one
// PowerShell each on a Windows without WMIC), and nothing ends them if they hang. process-table.ts reads the whole
// process table with ONE query, shares it between the jobs, and ends a query that does not return.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseWmicCsv, parsePowerShellRows, ProcessTable, runCommand, wmicDateToMs, monitoringNotice,
} = require('../src/process-table');
const { isAlive } = require('../src/process-tree');

const T0 = Date.UTC(2026, 10, 13, 12, 0, 0);
const row = (pid, ppid, cpu100ns, rssBytes, startedAtMs = T0 - 60_000) => ({ pid, ppid, cpu100ns, rssBytes, startedAtMs });

describe('parsing what Windows prints', () => {
  test('wmic csv: columns are found by name, CR CR LF endings and blank lines are ignored', () => {
    const text = '\r\r\nNode,CreationDate,KernelModeTime,ParentProcessId,ProcessId,UserModeTime,WorkingSetSize\r\r\n'
      + 'HOST,20261113130000.000000+060,100,4,120,50,8192\r\r\n\r\r\n'
      + 'HOST,,0,0,0,0,0\r\r\n';
    const rows = parseWmicCsv(text);
    assert.deepEqual(rows[0], { pid: 120, ppid: 4, cpu100ns: 150, rssBytes: 8192, startedAtMs: Date.UTC(2026, 10, 13, 12, 0, 0) });
    assert.equal(rows[1].startedAtMs, 0, 'a process with no creation date (System Idle) has start 0');
    assert.equal(rows.length, 2);
  });

  test('wmic date: the offset in minutes is applied, negative ones too', () => {
    assert.equal(wmicDateToMs('20261113130000.500000+060'), Date.UTC(2026, 10, 13, 12, 0, 0, 500));
    assert.equal(wmicDateToMs('20261113070000.000000-300'), Date.UTC(2026, 10, 13, 12, 0, 0));
  });

  test('wmic csv without the expected columns says which one is missing and how to check', () => {
    assert.throws(() => parseWmicCsv('Node,Foo\r\nH,1\r\n'), /no "\w+" column.*Node,Foo.*wmic process get .*ProcessId/s);
  });

  test('powershell rows: "pid ppid cpu rss startMs" per line', () => {
    const rows = parsePowerShellRows('120 4 150 8192 1000\r\n\r\n7 0 0 0 0\r\n');
    assert.deepEqual(rows, [row(120, 4, 150, 8192, 1000), row(7, 0, 0, 0, 0)]);
  });

  test('powershell output that is not rows is an error that shows the start of it', () => {
    assert.throws(() => parsePowerShellRows('Get-CimInstance : Access denied'), /Access denied/);
  });
});

function tableOver(snapshots, { ttlMs = 1000 } = {}) {
  let clock = T0;
  let reads = 0;
  const table = new ProcessTable({
    read: async () => snapshots[Math.min(reads++, snapshots.length - 1)],
    now: () => clock,
    ttlMs,
  });
  return { table, advance: (ms) => { clock += ms; }, reads: () => reads };
}

describe('the process table', () => {
  test('tree: the root and every descendant, by parent links', async () => {
    const { table } = tableOver([[row(10, 1, 0, 0), row(11, 10, 0, 0), row(12, 11, 0, 0), row(13, 1, 0, 0)]]);
    assert.deepEqual((await table.tree(10)).sort((a, b) => a - b), [10, 11, 12]);
  });

  test('tree: a cycle in the parent links ends', async () => {
    const { table } = tableOver([[row(10, 11, 0, 0), row(11, 10, 0, 0)]]);
    assert.deepEqual((await table.tree(10)).sort((a, b) => a - b), [10, 11]);
  });

  test('usage: memory, age, parent and the sample time come from the snapshot', async () => {
    const { table } = tableOver([[row(10, 1, 6_000_000_000, 4096, T0 - 60_000)]]);
    const usage = await table.usageMany([10]);
    assert.equal(usage[10].memory, 4096);
    assert.equal(usage[10].ppid, 1);
    assert.equal(usage[10].timestamp, T0);
    assert.equal(usage[10].elapsed, 60_000);
  });

  test('usage: the first sight of a process is its average since it started (what pidusage answered)', async () => {
    // 60 s of CPU in 600 s alive = 10 %
    const { table } = tableOver([[row(10, 1, 600_000_000, 0, T0 - 600_000)]]);
    assert.equal(Math.round((await table.usageMany([10]))[10].cpu), 10);
  });

  test('usage: afterwards the CPU is the change since the previous snapshot', async () => {
    const { table, advance } = tableOver([
      [row(10, 1, 0, 0, T0 - 600_000)],
      [row(10, 1, 50_000_000, 0, T0 - 600_000)],
    ]);
    await table.usageMany([10]);
    // 5 s of CPU (the 50_000_000 above) in 10 s
    advance(10_000);
    assert.equal(Math.round((await table.usageMany([10]))[10].cpu), 50);
  });

  test('usage: a pid that is not in the table is absent', async () => {
    const { table } = tableOver([[row(10, 1, 0, 0)]]);
    assert.deepEqual(Object.keys(await table.usageMany([10, 99])), ['10']);
  });

  test('usage: a pid reused by another process (other start time) is measured afresh, not as a delta', async () => {
    const { table, advance } = tableOver([
      [row(10, 1, 900_000_000, 0, T0 - 600_000)],
      [row(10, 1, 1_000, 0, T0 + 5_000)],
    ]);
    await table.usageMany([10]);
    advance(10_000);
    const cpu = (await table.usageMany([10]))[10].cpu;
    assert.ok(cpu >= 0 && cpu < 1, `cpu ${cpu}`);
  });

  test('every job asking within the time-to-live shares one read; after it, a new one', async () => {
    const { table, advance, reads } = tableOver([[row(10, 1, 0, 0)]], { ttlMs: 1000 });
    await Promise.all([table.tree(10), table.usageMany([10]), table.tree(10)]);
    assert.equal(reads(), 1);
    advance(500);
    await table.tree(10);
    assert.equal(reads(), 1);
    advance(600);
    await table.tree(10);
    assert.equal(reads(), 2);
  });

  test('never two reads at the same time: a slow read is awaited by whoever asks meanwhile', async () => {
    let inFlight = 0;
    let peak = 0;
    let reads = 0;
    const table = new ProcessTable({
      read: async () => {
        reads++;
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 50));
        inFlight--;
        return [row(10, 1, 0, 0)];
      },
      now: () => Date.now(),
      ttlMs: 0,
    });
    await Promise.all([table.tree(10), table.tree(10), table.tree(10)]);
    assert.equal(peak, 1);
    assert.equal(reads, 1);
  });

  // A process that starts after the snapshot is not in it. Without a fresh look the monitor saw a job's first sample as "the job
  // is gone", and the daemon at start found none of the supervisors that had just been started.
  test('a pid missing from a snapshot read before the question is looked up in a fresh one', async () => {
    const { table, advance, reads } = tableOver([[row(10, 1, 0, 0)], [row(10, 1, 0, 0), row(11, 10, 0, 0)]], { ttlMs: 60_000 });
    await table.usageMany([10]);
    advance(100);
    const usage = await table.usageMany([10, 11]);
    assert.deepEqual(Object.keys(usage), ['10', '11']);
    assert.equal(reads(), 2);
  });

  test('a pid missing from the snapshot this very question caused is not looked up again', async () => {
    const { table, reads } = tableOver([[row(10, 1, 0, 0)]]);
    assert.deepEqual(Object.keys(await table.usageMany([10, 99])), ['10']);
    assert.equal(reads(), 1);
  });

  test('tree of a root that started since the snapshot reads a fresh one', async () => {
    const { table, advance, reads } = tableOver([[row(10, 1, 0, 0)], [row(10, 1, 0, 0), row(11, 1, 0, 0), row(12, 11, 0, 0)]], { ttlMs: 60_000 });
    await table.tree(10);
    advance(100);
    assert.deepEqual((await table.tree(11)).sort((a, b) => a - b), [11, 12]);
    assert.equal(reads(), 2);
  });

  test('a read already running when the question is asked does not answer it: it may predate the process', async () => {
    let clock = T0;
    let reads = 0;
    let release;
    const table = new ProcessTable({
      read: async () => {
        reads++;
        if (reads === 1) { await new Promise((r) => { release = r; }); return [row(10, 1, 0, 0)]; }
        return [row(10, 1, 0, 0), row(11, 10, 0, 0)];
      },
      now: () => clock,
      ttlMs: 0,
    });
    const first = table.usageMany([10]);
    clock += 50;
    const second = table.usageMany([11]);
    release();
    await first;
    assert.deepEqual(Object.keys(await second), ['11']);
    assert.equal(reads, 2);
  });

  // The second machine's queries took 30-40 s: started every sample they piled up and slowed the whole PC. A table
  // that is slow to read is read less often: never more than half of the time is spent waiting for a query.
  test('a slow read pushes the next one back by as long as it took', async () => {
    let clock = T0;
    let reads = 0;
    const table = new ProcessTable({
      read: async () => { reads++; clock += 3000; return [row(10, 1, 0, 0)]; },
      now: () => clock,
      ttlMs: 1000,
    });
    await table.tree(10);
    clock += 2000;
    await table.tree(10);
    assert.equal(reads, 1, 'asked again 2 s after a read that took 3 s');
    clock += 1500;
    await table.tree(10);
    assert.equal(reads, 2);
  });

  test('a failed read is not cached: the next question reads again, and the failure is counted', async () => {
    let calls = 0;
    const table = new ProcessTable({
      read: async () => { if (calls++ === 0) { throw new Error('boom'); } return [row(10, 1, 0, 0)]; },
      now: () => Date.now(),
      ttlMs: 60_000,
    });
    await assert.rejects(table.tree(10), /boom/);
    assert.deepEqual(await table.tree(10), [10]);
    assert.equal(table.stats().failures, 1);
    assert.equal(table.stats().reads, 2);
  });
});

describe('running the query', () => {
  const node = process.execPath;

  test('returns what the command printed', async () => {
    assert.equal((await runCommand(node, ['-e', 'process.stdout.write("hi")'], { timeoutMs: 10_000, what: 'test' })).trim(), 'hi');
  });

  test('a command that fails says its exit code and its stderr', async () => {
    await assert.rejects(
      runCommand(node, ['-e', 'console.error("nope"); process.exit(3)'], { timeoutMs: 10_000, what: 'the test query' }),
      /the test query.*exit code 3.*nope/s,
    );
  });

  test('a command that does not return is ended, its process is gone, and the error says what to do', async () => {
    let pid;
    await assert.rejects(
      runCommand(node, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300, what: 'the test query', onSpawn: (p) => { pid = p; } }),
      /the test query.*did not finish within 0\.3 s.*ended/s,
    );
    assert.ok(typeof pid === 'number');
    for (let i = 0; i < 50 && isAlive(pid); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(isAlive(pid), false, `process ${pid} is still running: it leaked`);
  });

  test('a command that is missing says so', async () => {
    await assert.rejects(runCommand('orch-no-such-binary', [], { timeoutMs: 1000, what: 'the test query' }), /the test query.*orch-no-such-binary/s);
  });
});

describe('the notice at daemon start', () => {
  test('PowerShell: says why, what it costs and what lowers it', () => {
    const text = monitoringNotice('powershell');
    assert.match(text, /WMIC is not installed/);
    assert.match(text, /PowerShell/);
    assert.match(text, /--sample-interval/);
  });

  test('wmic and the other platforms need no notice', () => {
    assert.equal(monitoringNotice('wmic'), null);
    assert.equal(monitoringNotice('pidusage'), null);
  });
});
