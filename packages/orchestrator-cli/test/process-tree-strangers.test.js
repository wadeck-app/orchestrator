'use strict';

// pidtree walks ParentProcessId, and on Windows a pid is reused once the process holding it dies.
// A live, unrelated process can therefore still name a dead pid as its parent -- and when that pid is
// recycled onto one of our job's processes, pidtree(ourPid) hands back strangers. Measured on this
// machine: 29 dead pids named as parent by a live process, one of them yielding 152 pids.
//
// The resource monitor sums CPU and RAM over whatever pidtree returns, so a stranger's load was
// attributed to the job -- enough to trip the hard resource budget and have the daemon kill a job
// that was doing nothing wrong.
//
// A descendant cannot predate its ancestor, so pidusage's own `elapsed` settles it without a second
// query: any sampled process older than the root was not started by it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sampleProcessTree } = require('../src/scheduler');

const MB = 1024 * 1024;

const ROOT = 1000;

/**
 * pidusage-shaped sample. `elapsed` is milliseconds since that process started, `ppid` the parent it
 * claims -- which is the field the recycled-pid artefact corrupts. Defaults to a direct child of the
 * root, since most fixtures here are about age rather than about the shape of the tree.
 */
function usage({ cpu, mb, elapsed, ppid = ROOT }) {
  return { cpu, memory: mb * MB, elapsed, ppid };
}

/** Injects a fake tree walk and a fake sampler, keyed by pid. */
function deps(pids, samples) {
  return {
    tree:  async () => pids,
    usage: async (pid) => {
      const s = samples[pid];
      if (!s) throw new Error(`no such process: ${pid}`);
      return s;
    },
  };
}

describe('a process older than the root is not part of the job', () => {
  test('a stranger is left out of the total', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 4242], {
      [ROOT]: usage({ cpu: 10, mb: 100, elapsed: 5_000 }),
      // Running for an hour: it cannot have been spawned by a job that started 5s ago.
      4242:   usage({ cpu: 80, mb: 900, elapsed: 3_600_000 }),
    }));

    assert.equal(result.cpuPct, 10, 'a stranger\'s CPU was charged to the job');
    assert.equal(result.ramMb, 100);
  });

  test('genuine descendants are still counted', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 1001, 1002], {
      [ROOT]: usage({ cpu: 5,  mb: 50,  elapsed: 10_000 }),
      1001:   usage({ cpu: 20, mb: 200, elapsed: 9_000 }),
      1002:   usage({ cpu: 15, mb: 150, elapsed: 1_000 }),
    }));

    assert.equal(result.cpuPct, 40);
    assert.equal(result.ramMb, 400);
  });

  test('many strangers cannot drown out the job', async () => {
    const pids = [ROOT];
    const samples = { [ROOT]: usage({ cpu: 3, mb: 30, elapsed: 2_000 }) };
    for (let i = 0; i < 150; i++) {
      pids.push(9000 + i);
      samples[9000 + i] = usage({ cpu: 1, mb: 10, elapsed: 600_000 });
    }

    const result = await sampleProcessTree(ROOT, deps(pids, samples));

    assert.equal(result.cpuPct, 3, '150 strangers were summed into the job');
  });

  // Both values come from separate calls and the clock has finite resolution, so a child spawned in
  // the same instant as the root can measure a hair older. Refusing it would drop real descendants.
  test('a descendant within the clock tolerance is kept', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 1001], {
      [ROOT]: usage({ cpu: 1, mb: 10, elapsed: 4_000 }),
      1001:   usage({ cpu: 2, mb: 20, elapsed: 4_300 }),
    }));

    assert.equal(result.cpuPct, 3);
  });
});

// Age alone is not enough, and another session was right to say so. If a descendant of ours exits and
// its pid is handed to an unrelated process, that process's own children name the recycled pid as
// their parent -- and they are YOUNGER than our root, so no age test can tell them apart. What does
// is that the link itself has to hold: a pid belongs to the job only if the parent it claims is
// itself part of the job and older than it.
describe('a young process hanging off a recycled descendant pid', () => {
  test('is left out, because the parent it claims is not in the job', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 1001, 1002], {
      [ROOT]: usage({ cpu: 4, mb: 40, elapsed: 60_000 }),
      // 1001 is gone -- it is the pid that got recycled, so it cannot be sampled at all.
      // 1002 is a child of whatever holds 1001 now, and it started well after our root.
      1002: usage({ cpu: 90, mb: 800, elapsed: 3_000, ppid: 1001 }),
    }));

    assert.equal(result.cpuPct, 4, 'a young stranger was charged to the job');
    assert.equal(result.ramMb, 40);
  });

  test('a genuine grandchild through a live child is kept', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 1001, 1002], {
      [ROOT]: usage({ cpu: 1, mb: 10, elapsed: 60_000 }),
      1001:   usage({ cpu: 2, mb: 20, elapsed: 50_000, ppid: ROOT }),
      1002:   usage({ cpu: 4, mb: 40, elapsed: 40_000, ppid: 1001 }),
    }));

    assert.equal(result.cpuPct, 7, 'a real grandchild was dropped');
    assert.equal(result.ramMb, 70);
  });

  test('a child older than the parent it claims is still refused', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 1001, 1002], {
      [ROOT]: usage({ cpu: 1, mb: 10, elapsed: 60_000 }),
      1001:   usage({ cpu: 2, mb: 20, elapsed: 50_000, ppid: ROOT }),
      // Claims 1001 as its parent while having started 10 minutes before it.
      1002:   usage({ cpu: 99, mb: 999, elapsed: 600_000, ppid: 1001 }),
    }));

    assert.equal(result.cpuPct, 3);
  });
});

describe('what happens when the root itself cannot be sampled', () => {
  // Without the root there is no reference to judge the others against, and no job process left to
  // attribute anything to: the job has exited.
  test('a dead root yields null even when other pids answer', async () => {
    const result = await sampleProcessTree(ROOT, deps([ROOT, 4242], {
      4242: usage({ cpu: 80, mb: 900, elapsed: 3_600_000 }),
    }));

    assert.equal(result, null, 'usage was reported for a job whose own process is gone');
  });

  test('nothing sampled at all yields null', async () => {
    assert.equal(await sampleProcessTree(ROOT, deps([ROOT], {})), null);
  });
});

describe('the tree walk failing is still survivable', () => {
  test('a failed walk falls back to the root alone', async () => {
    const result = await sampleProcessTree(ROOT, {
      tree:  async () => { throw new Error('walk failed'); },
      usage: async (pid) => {
        assert.equal(pid, ROOT, 'sampled something other than the root after a failed walk');
        return usage({ cpu: 7, mb: 70, elapsed: 1_000 });
      },
    });

    assert.equal(result.cpuPct, 7);
    assert.equal(result.ramMb, 70);
  });
});

// The production call passes no deps, so the real pidtree/pidusage must still be wired in.
describe('the default wiring is unchanged', () => {
  test('a pid that cannot exist yields null through the real implementation', async () => {
    assert.equal(await sampleProcessTree(2147483646), null);
  });
});
