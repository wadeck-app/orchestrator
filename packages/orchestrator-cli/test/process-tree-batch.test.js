'use strict';

// Measuring a job's tree used to ask pidusage once per process: on Windows without WMIC that is one PowerShell
// per process of the tree, every sample. The whole tree is now one question, so the cost does not grow with it.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { sampleProcessTree } = require('../src/scheduler');

const MB = 1024 * 1024;
const ROOT = process.pid; // a pid that is alive, which the failure path below relies on
const T0 = 1_800_000_000_000;

const sample = (ppid) => ({ cpu: 1, memory: MB, elapsed: 60_000, timestamp: T0, ppid });

describe('measuring a tree in one call', () => {
  test('asks for every pid of the tree in a single call', async () => {
    const asked = [];
    const pids = [ROOT, ROOT + 1, ROOT + 2, ROOT + 3];
    const usageMany = async (list) => {
      asked.push([...list]);
      return Object.fromEntries(list.map((pid) => [pid, sample(pid === ROOT ? 1 : ROOT)]));
    };

    const result = await sampleProcessTree(ROOT, { tree: async () => pids, usageMany });

    assert.deepEqual(asked, [pids]);
    assert.equal(result.counted, 4);
    assert.equal(result.ramMb, 4);
  });

  test('a pid absent from the answer is a process that is gone: the others are still counted', async () => {
    const usageMany = async () => ({ [ROOT]: sample(1), [ROOT + 1]: sample(ROOT) });

    const result = await sampleProcessTree(ROOT, { tree: async () => [ROOT, ROOT + 1, ROOT + 2], usageMany });

    assert.equal(result.walked, 3);
    assert.equal(result.counted, 2);
  });

  test('a root absent from the answer is a job that has exited: null', async () => {
    const usageMany = async () => ({ [ROOT + 1]: sample(ROOT) });

    assert.equal(await sampleProcessTree(ROOT, { tree: async () => [ROOT, ROOT + 1], usageMany }), null);
  });

  test('a failing call while the root is alive is an error the caller logs, not "the job exited"', async () => {
    const usageMany = async () => { throw new Error('powershell timed out after 15 s'); };

    await assert.rejects(
      sampleProcessTree(ROOT, { tree: async () => [ROOT], usageMany }),
      /powershell timed out after 15 s/,
    );
  });

  test('a failing call while the root is gone is the job having exited: null', async () => {
    const gone = 2_147_000_000;
    const usageMany = async () => { throw new Error('No matching pid found'); };

    assert.equal(await sampleProcessTree(gone, { tree: async () => [gone], usageMany }), null);
  });
});
