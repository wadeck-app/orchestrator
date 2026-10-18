'use strict';

// sampleProcessTree used to ask for every process of the tree at once: `Promise.all(pids.map(usage))`.
// On macOS each of those is a `ps` process (Linux reads /proc, which starts nothing), so measuring a job
// with 400 descendants started 400 processes in the same instant, every two seconds, for as long as the
// job ran. The CI runners there allow 1333 processes per user: past that, spawn fails with EAGAIN, which
// is the error the macOS leg of CI kept dying on, in whichever test happened to be starting a process.
//
// The measurement does not need to be instantaneous, only complete, so the number of measurements in
// flight is capped.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sampleProcessTree, MAX_CONCURRENT_USAGE_CALLS } = require('../src/scheduler');

const MB = 1024 * 1024;
const ROOT = 1000;
const T0 = 1_800_000_000_000;

function sample(ppid) {
  return { cpu: 1, memory: MB, elapsed: 60_000, timestamp: T0, ppid };
}

/** A usage function that remembers how many calls were running at the same time. */
function trackedUsage(children) {
  const seen = { inFlight: 0, peak: 0, calls: 0 };
  const usage = async (pid) => {
    seen.calls++;
    seen.inFlight++;
    seen.peak = Math.max(seen.peak, seen.inFlight);
    // A real measurement takes time; without a turn of the event loop nothing would overlap.
    await new Promise((resolve) => setImmediate(resolve));
    seen.inFlight--;
    return sample(pid === ROOT ? 1 : ROOT);
  };
  const pids = [ROOT, ...Array.from({ length: children }, (_, i) => ROOT + 1 + i)];
  return { seen, usage, tree: async () => pids };
}

describe('measuring a big process tree', () => {
  test('never has more than the cap of measurements in flight', async () => {
    const { seen, usage, tree } = trackedUsage(400);

    await sampleProcessTree(ROOT, { tree, usage });

    assert.ok(seen.peak <= MAX_CONCURRENT_USAGE_CALLS, `${seen.peak} measurements at once, the cap is ${MAX_CONCURRENT_USAGE_CALLS}`);
  });

  test('still measures every process of the tree', async () => {
    const { seen, usage, tree } = trackedUsage(400);

    const result = await sampleProcessTree(ROOT, { tree, usage });

    assert.equal(seen.calls, 401);
    assert.equal(result.walked, 401);
    assert.equal(result.counted, 401);
  });

  test('keeps the cap small enough to stay far under a per-user process limit', () => {
    assert.ok(MAX_CONCURRENT_USAGE_CALLS >= 1 && MAX_CONCURRENT_USAGE_CALLS <= 16, `cap is ${MAX_CONCURRENT_USAGE_CALLS}`);
  });

  test('a process that vanished between the walk and its measurement does not discard the others', async () => {
    const usage = async (pid) => {
      if (pid === ROOT + 2) {
        throw new Error('gone');
      }
      return sample(pid === ROOT ? 1 : ROOT);
    };

    const result = await sampleProcessTree(ROOT, { tree: async () => [ROOT, ROOT + 1, ROOT + 2, ROOT + 3], usage });

    assert.equal(result.counted, 3);
  });
});
