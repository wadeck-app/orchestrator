'use strict';

// sampleProcessTree refuses any process that is older than the job, as a guard against pid reuse
// attributing a stranger's load to it. It used to compare pidusage's `elapsed`, which is the age AT THE
// MOMENT THAT PROCESS WAS MEASURED. On Windows each process is a separate WMI query, and under load the
// answers arrive seconds apart: a real child measured three seconds after its parent looked three
// seconds OLDER than it, was refused as "not ours", and the job was measured as its idle shell wrapper.
//
// That is a measurement that changes with how busy the machine is: the same job peaking at 17 MB on a
// quiet run and 147 MB on a run where the children happened to be counted. Since the hard budget is
// derived from the peaks of past runs, an undercount in the runs that set the baseline kills the run
// that is finally measured correctly.
//
// What does not depend on when a process was measured is when it was created: timestamp - elapsed.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sampleProcessTree } = require('../src/scheduler');

const MB = 1024 * 1024;
const ROOT = 1000;

/** A pidusage sample for a process that STARTED at `startedAt`, measured at `measuredAt` (ms epoch). */
function measured({ mb, startedAt, measuredAt, ppid = ROOT, cpu = 1 }) {
  return { cpu, memory: mb * MB, elapsed: measuredAt - startedAt, timestamp: measuredAt, ppid };
}

const T0 = 1_800_000_000_000;

describe('the tree guard compares when processes were created, not how old they looked when measured', () => {
  test('counts a real child whose measurement arrived seconds after its parent\'s', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 2000],
      usage: async (pid) => ({
        // The shell started first, the child one second later.
        [ROOT]: measured({ mb: 7, startedAt: T0, measuredAt: T0 + 60_000, ppid: 1 }),
        // Same child, but its WMI answer came back three seconds later than the parent's.
        2000: measured({ mb: 120, startedAt: T0 + 1_000, measuredAt: T0 + 63_000 }),
      })[pid],
    });

    assert.equal(usage.counted, 2, 'the real child was refused because it was measured late');
    assert.equal(Math.round(usage.ramMb), 127);
  });

  test('counts a real child measured BEFORE its parent as well', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 2000],
      usage: async (pid) => ({
        [ROOT]: measured({ mb: 7, startedAt: T0, measuredAt: T0 + 64_000, ppid: 1 }),
        2000: measured({ mb: 120, startedAt: T0 + 1_000, measuredAt: T0 + 60_000 }),
      })[pid],
    });
    assert.equal(usage.counted, 2);
  });

  test('still refuses a stranger that really is older than the job, however late it was measured', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 9999],
      usage: async (pid) => ({
        [ROOT]: measured({ mb: 7, startedAt: T0, measuredAt: T0 + 60_000, ppid: 1 }),
        // Created an hour before the job: it cannot be its descendant.
        9999: measured({ mb: 500, startedAt: T0 - 3_600_000, measuredAt: T0 + 63_000 }),
      })[pid],
    });

    assert.equal(usage.counted, 1);
    assert.equal(Math.round(usage.ramMb), 7);
  });

  test('still refuses a stranger created just before the job, beyond the clock tolerance', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 9999],
      usage: async (pid) => ({
        [ROOT]: measured({ mb: 7, startedAt: T0, measuredAt: T0 + 60_000, ppid: 1 }),
        9999: measured({ mb: 500, startedAt: T0 - 5_000, measuredAt: T0 + 60_000 }),
      })[pid],
    });
    assert.equal(usage.counted, 1);
  });

  test('keeps working on samples that carry no timestamp, as the older fixtures do', async () => {
    const usage = await sampleProcessTree(ROOT, {
      tree: async () => [ROOT, 2000, 9999],
      usage: async (pid) => ({
        [ROOT]: { cpu: 1, memory: 7 * MB, elapsed: 5000, ppid: 1 },
        2000: { cpu: 1, memory: 20 * MB, elapsed: 4000, ppid: ROOT },
        9999: { cpu: 1, memory: 500 * MB, elapsed: 900_000, ppid: ROOT },
      })[pid],
    });
    assert.equal(usage.counted, 2);
  });
});
