'use strict';

// The contract every registered strategy honours WITH real logs: 20 usable runs of about 1 MB each.
// Iterates STRATEGIES, so a strategy added later is covered without touching this file (it must get options in
// OPTIONS, or the first test fails and says so).
//
// Cost is asserted on work, which is deterministic: bytes read from the logs by one estimate. Time is asserted as CPU
// time of the process (process.cpuUsage), not wall time: a loaded machine can leave the process waiting for a core for
// seconds (1.7 s and 2.7 s were measured for an estimate that needs well under 1 s of CPU), which says nothing about the code.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { STRATEGIES } = require('../src/progress/registry');
const fx = require('./progress/helpers/fixture-builder');

after(fx.cleanupTemp);

const OPTIONS = {
  history: undefined,
  declared: undefined,
  'log-learned': undefined,
  ensemble: undefined,
  ratio: { pattern: '(\\d+)/(\\d+)' },
  'log-declared': { milestones: [{ pattern: '^Stage two', at: 0.35 }, { pattern: '^Stage three', at: 0.65 }] },
};

/** CPU time bound for one estimate (ms): 5 times the 200 ms target. */
const TIME_BOUND_MS = 1000;
/** Bytes one estimate may read: the current log (cap 5 MB) plus a few MB of past logs, whatever the strategy. */
const READ_BYTES_BOUND = 12 * 1024 * 1024;
const LOG_BYTES = 1024 * 1024;

/** A log of about 1 MB: 14000 lines of 70 bytes, stage lines at 10/35/65/90 % and counters. */
function bigLog(durationSec, salt) {
  const lines = [];
  const total = 14_000;
  const stageAt = new Map([[0.10, 'Stage one'], [0.35, 'Stage two'], [0.65, 'Stage three'], [0.90, 'Stage four']]);
  let next = [...stageAt.keys()];
  for (let i = 0; i < total; i++) {
    const f = i / total;
    if (next.length > 0 && f >= next[0]) {
      lines.push([Math.round(f * durationSec), `${stageAt.get(next[0])} started for batch ${salt}`]);
      next = next.slice(1);
    }
    lines.push([Math.round(f * durationSec), `processing item ${i} of ${total} in worker ${i % 8} took ${(i * 7) % 90} ms ok`]);
  }
  lines.push([Math.round(0.4 * durationSec), '##orch-progress 40 half way']);
  return lines.sort((a, b) => a[0] - b[0]);
}

let built;

before(() => {
  const runs = Array.from({ length: 20 }, (_, i) => ({ agoMin: 120 * (i + 1), durationSec: 600 + (i % 3) * 10, lines: bigLog(600, i) }));
  const current = { elapsedSec: 300, lines: bigLog(600, 99).filter(([s]) => s <= 300) };
  built = fx.buildCase(fx.tempDir(), { runs, current });
  const dir = built.logDir;
  // 20 finished runs of about 1 MB, and the open run, half done.
  const sizes = fs.readdirSync(dir).map(f => fs.statSync(path.join(dir, f)).size).sort((x, y) => y - x);
  assert.equal(sizes.length, 21);
  assert.ok(sizes.slice(0, 20).every(s => s > 0.5 * LOG_BYTES && s < 2 * LOG_BYTES), `the past logs are about 1 MB (sizes ${sizes.slice(0, 20).join(', ')})`);
});

/** The context, with the log reads counted. */
function counted(options) {
  const ctx = fx.contextOf(built, { options });
  const counter = { bytes: 0 };
  const wrap = (reader) => ({
    ...reader,
    exists: () => reader.exists(),
    readFrom(offset) {
      const got = reader.readFrom(offset);
      counter.bytes += got.nextOffset - offset;
      return got;
    },
    tail(maxBytes) {
      const lines = reader.tail(maxBytes);
      counter.bytes += lines.reduce((a, l) => a + l.text.length + 22, 0);
      return lines;
    },
  });
  return {
    counter,
    ctx: {
      ...ctx,
      logs: {
        currentRun: () => wrap(ctx.logs.currentRun()),
        pastRuns: (limit) => ctx.logs.pastRuns(limit).map(p => ({ entry: p.entry, reader: wrap(p.reader) })),
      },
    },
  };
}

describe('every strategy, 20 logs of about 1 MB', () => {
  test('every registered strategy has options in this test', () => {
    for (const s of STRATEGIES) {
      assert.ok(Object.prototype.hasOwnProperty.call(OPTIONS, s.id), `add the options that make "${s.id}" run to OPTIONS in progress-contract-logs.test.js`);
    }
  });

  for (const strategy of STRATEGIES) {
    describe(strategy.id, () => {
      const checked = () => {
        const r = strategy.validateOptions(OPTIONS[strategy.id]);
        assert.equal(r.ok, true, JSON.stringify(r));
        return r.value;
      };

      test('never throws, keeps the contract', () => {
        const { ctx } = counted(checked());
        const e = strategy.estimate(ctx);
        assert.equal(e.strategyId, strategy.id);
        if (e.progress === null) {
          assert.ok(e.reason.trim().length > 0);
        } else {
          assert.ok(e.progress >= 0 && e.progress <= 1);
          assert.ok(e.etaAt === null || Date.parse(e.etaAt) >= built.now);
        }
        assert.ok(e.confidenceScore >= 0 && e.confidenceScore <= 1);
      });

      test('is deterministic: two fresh contexts, the same answer', () => {
        const a = strategy.estimate(counted(checked()).ctx);
        const b = strategy.estimate(counted(checked()).ctx);
        assert.deepEqual(a, b);
      });

      test(`reads a bounded amount (at most ${READ_BYTES_BOUND / 1024 / 1024} MB) in one estimate`, () => {
        const { ctx, counter } = counted(checked());
        strategy.estimate(ctx);
        assert.ok(counter.bytes <= READ_BYTES_BOUND, `${strategy.id} read ${counter.bytes} bytes`);
      });

      test(`answers within ${TIME_BOUND_MS} ms (target 200 ms)`, () => {
        const { ctx } = counted(checked());
        // One call to warm the JIT and the regex compile, one measured: the first call of a process is not the daemon's steady state.
        strategy.estimate(counted(checked()).ctx);
        const t0 = process.cpuUsage();
        strategy.estimate(ctx);
        const used = process.cpuUsage(t0);
        const ms = (used.user + used.system) / 1000;
        assert.ok(ms < TIME_BOUND_MS, `${strategy.id} used ${ms.toFixed(1)} ms of CPU`);
      });
    });
  }
});
