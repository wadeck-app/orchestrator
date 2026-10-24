'use strict';

// The replay harness: each usable past run is replayed as if it were open, at sampled elapsed times, with only
// the runs older than it as history (leave-one-out, no look-ahead). Used by `orch progress replay` and by `ensemble`.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');

const { replayJob } = require('../../src/progress/replay');
const { createLogCorpus } = require('../../src/progress/log-corpus');
const { historyStrategy } = require('../../src/progress/history-strategy');
const fx = require('./helpers/fixture-builder');

after(fx.cleanupTemp);

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';

function corpusOf(c) {
  return createLogCorpus({ configDir: c.configDir, jobId: c.job.id, history: c.history, currentStartedAt: FAR_FUTURE });
}

function stable(n, durationSec, lines = []) {
  return Array.from({ length: n }, (_, i) => ({ agoMin: 60 * (i + 1), durationSec, lines }));
}

function replay(c, strategies, extra = {}) {
  return replayJob({ job: c.job, configDir: c.configDir, corpus: corpusOf(c), strategies, ...extra });
}

/** A strategy built from a function, for the harness to call. */
function fake(id, fn) {
  return {
    id, version: 1,
    validateOptions: (raw) => ({ ok: true, value: raw }),
    estimate: (ctx) => fn(ctx),
  };
}

function est(ctx, extra) {
  return { strategyId: 'f', progress: 0.5, etaAt: ctx.now().toISOString(), confidence: 'high', confidenceScore: 1, reason: 'r', serverNow: ctx.now().toISOString(), ...extra };
}

describe('replayJob: sampling', () => {
  test('samples every 5 % of each replayed run by default: 19 samples per run', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(6, 600) });
    const r = replay(c, [historyStrategy]);
    assert.equal(r.runs, 6);
    assert.equal(r.strategies.history.samples.length, 6 * 19);
    const fractions = new Set(r.strategies.history.samples.map(s => s.fraction));
    assert.deepEqual([...fractions].sort((a, b) => a - b).slice(0, 3), [0.05, 0.1, 0.15]);
  });

  test('sampleEveryPercent 25 gives 25, 50 and 75 %', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(4, 600) });
    const r = replay(c, [historyStrategy], { sampleEveryPercent: 25 });
    assert.deepEqual([...new Set(r.strategies.history.samples.map(s => s.fraction))], [0.25, 0.5, 0.75]);
  });

  test('refuses a sampling step that is not a whole number from 1 to 50', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(4, 600) });
    assert.throws(() => replay(c, [historyStrategy], { sampleEveryPercent: 0 }), /sampleEveryPercent must be a whole number from 1 to 50/);
    assert.throws(() => replay(c, [historyStrategy], { sampleEveryPercent: 5.5 }), /sampleEveryPercent must be a whole number from 1 to 50/);
  });

  test('maxRuns keeps the newest usable runs', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(8, 600) });
    const r = replay(c, [historyStrategy], { maxRuns: 5 });
    assert.equal(r.runs, 5);
  });

  test('failed, killed, orphaned and skipped runs are not replayed', () => {
    const bad = [
      { exitCode: 1 }, { exitCode: null, extra: { orphaned: true } }, { exitCode: null, extra: { cancelledByUser: true } }, { exitCode: null, extra: { skipped: true } },
    ].map((b, i) => ({ agoMin: 600 + i * 60, durationSec: 100, ...b }));
    const c = fx.buildCase(fx.tempDir(), { runs: [...stable(4, 600), ...bad] });
    assert.equal(replay(c, [historyStrategy]).runs, 4);
  });
});

describe('replayJob: leave-one-out, no look-ahead', () => {
  test('a run sees only older runs as history, itself as the open run, and the clock at the sample', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(5, 600) });
    const seen = [];
    const spy = fake('spy', (ctx) => {
      const open = ctx.history.filter(e => !e.finishedAt);
      assert.equal(open.length, 1);
      assert.equal(open[0].startedAt, ctx.run.startedAt);
      const newer = ctx.history.filter(e => e.startedAt > ctx.run.startedAt);
      assert.deepEqual(newer, [], 'the history holds no run newer than the replayed one');
      const past = ctx.logs.pastRuns(20).map(p => p.entry.startedAt);
      assert.ok(past.every(s => s < ctx.run.startedAt), 'pastRuns holds only older runs');
      seen.push({ started: ctx.run.startedAt, past: past.length, elapsed: ctx.now().getTime() - Date.parse(ctx.run.startedAt) });
      return est(ctx);
    });
    replay(c, [spy], { sampleEveryPercent: 50 });
    const oldest = seen.reduce((a, b) => (a.started < b.started ? a : b));
    assert.equal(oldest.past, 0);
    assert.ok(seen.some(s => s.past === 4), 'the newest run sees the four older ones');
    assert.ok(seen.every(s => s.elapsed === 300_000), 'a 50 % sample of a 600 s run is at 300 s');
  });

  test('the current log is cut at the sample time', () => {
    const lines = [[100, 'Step one'], [300, 'Step two'], [500, 'Step three']];
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600, lines) });
    const counts = [];
    const spy = fake('spy', (ctx) => {
      const got = ctx.logs.currentRun().readFrom(0).lines.filter(l => /^Step/.test(l.text));
      const startMs = Date.parse(ctx.run.startedAt);
      assert.ok(got.every(l => l.ts.getTime() <= ctx.now().getTime()), 'no line after the clock');
      counts.push([(ctx.now().getTime() - startMs) / 1000, got.length]);
      return est(ctx);
    });
    replay(c, [spy], { sampleEveryPercent: 25 });
    for (const [elapsed, n] of counts) {
      assert.equal(n, elapsed >= 500 ? 3 : elapsed >= 300 ? 2 : elapsed >= 100 ? 1 : 0, `at ${elapsed} s: ${n} lines`);
    }
  });

  test('tail() is cut too', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600, [[100, 'Step one'], [500, 'Step three']]) });
    const spy = fake('spy', (ctx) => {
      const got = ctx.logs.currentRun().tail(1024 * 1024).filter(l => /^Step/.test(l.text));
      assert.ok(got.every(l => l.ts.getTime() <= ctx.now().getTime()));
      return est(ctx);
    });
    replay(c, [spy], { sampleEveryPercent: 25 });
  });

  test('readFrom with a non-zero offset is refused loudly', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600) });
    const spy = fake('spy', (ctx) => {
      ctx.logs.currentRun().readFrom(10);
      return est(ctx);
    });
    const r = replay(c, [spy], { sampleEveryPercent: 50 });
    assert.match(r.strategies.spy.errors[0], /replay supports readFrom\(0\) and tail\(\) only/);
  });
});

describe('replayJob: metrics', () => {
  test('history on identical durations is exact: zero error at every sample, from the fourth run on', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(8, 600) });
    const m = replay(c, [historyStrategy]).strategies.history.metrics;
    // Runs 1-3 have fewer than 3 older runs: no estimate. The five others are exact.
    assert.equal(m.maeSec, 0);
    assert.equal(m.maePct, 0);
    assert.equal(m.monotonicityViolations, 0);
    assert.equal(m.etaFlips, 0);
    assert.ok(Math.abs(m.coverage - 5 / 8) < 1e-9, `coverage ${m.coverage}`);
    assert.equal(m.byFraction[25].maeSec, 0);
    assert.equal(m.byFraction[75].maeSec, 0);
  });

  test('history on a run 50 % longer than usual: the error is counted in seconds and in % of the duration', () => {
    const runs = [{ agoMin: 60, durationSec: 900 }, ...stable(5, 600).map((r, i) => ({ ...r, agoMin: 60 * (i + 2) }))];
    const c = fx.buildCase(fx.tempDir(), { runs });
    const r = replay(c, [historyStrategy], { sampleEveryPercent: 25 });
    // The 900 s run is estimated to end at 600 s: at 25 % (225 s) and at 50 % (450 s) the ETA is 300 s early;
    // at 75 % (675 s) history is overdue (no ETA) and counts as ending now, 225 s early.
    const samples = r.strategies.history.samples.filter(s => s.runStartedAt === new Date(fx.T0 - 60 * fx.MIN).toISOString());
    const at = (f) => samples.find(s => s.fraction === f);
    assert.equal(at(0.25).errorMs, 300_000);
    assert.ok(Math.abs(at(0.25).errorPct - 300 / 900) < 1e-9);
    assert.equal(at(0.5).errorMs, 300_000);
    assert.equal(at(0.75).errorMs, 225_000);
    assert.equal(at(0.75).overdue, true);
  });

  test('progress that goes down is a monotonicity violation', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600) });
    const down = fake('down', (ctx) => {
      const f = (ctx.now().getTime() - Date.parse(ctx.run.startedAt)) / 600_000;
      return est(ctx, { progress: f === 0.5 ? 0.1 : f });
    });
    const m = replay(c, [down], { sampleEveryPercent: 25 }).strategies.down.metrics;
    assert.equal(m.monotonicityViolations, 3);
  });

  test('an end time that jumps by more than 20 % of the run between two samples is an ETA flip', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600) });
    const flip = fake('flip', (ctx) => {
      const el = ctx.now().getTime() - Date.parse(ctx.run.startedAt);
      const end = el === 300_000 ? 900_000 : 600_000;
      return est(ctx, { etaAt: new Date(Date.parse(ctx.run.startedAt) + end).toISOString() });
    });
    const m = replay(c, [flip], { sampleEveryPercent: 25 }).strategies.flip.metrics;
    // 25 -> 50 jumps +300 s, 50 -> 75 jumps -300 s: two flips per run.
    assert.equal(m.etaFlips, 6);
  });

  test('a strategy with no estimate counts in coverage, not in the error', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(3, 600) });
    const nothing = fake('nothing', (ctx) => est(ctx, { progress: null, etaAt: null, confidence: 'none', confidenceScore: 0, reason: 'nothing to say' }));
    const m = replay(c, [nothing], { sampleEveryPercent: 50 }).strategies.nothing.metrics;
    assert.equal(m.coverage, 0);
    assert.equal(m.maeSec, null);
    assert.equal(m.maePct, null);
    assert.equal(m.samples, 3);
  });

  test('a strategy that throws is an error entry, not a crash, and the others still run', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(5, 600) });
    const boom = fake('boom', () => { throw new Error('kaboom'); });
    const r = replay(c, [boom, historyStrategy], { sampleEveryPercent: 50 });
    assert.match(r.strategies.boom.errors[0], /kaboom/);
    assert.equal(r.strategies.boom.metrics.coverage, 0);
    assert.ok(r.strategies.history.metrics.coverage > 0);
  });

  test('a strategy handed a store keeps it across the runs (leakage-safe strategies only)', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(4, 600) });
    const shared = fx.memoryStore();
    let writes = 0;
    const counting = fake('counting', (ctx) => {
      ctx.store.write({ n: (ctx.store.read()?.n ?? 0) + 1 });
      writes++;
      return est(ctx);
    });
    replay(c, [counting], { sampleEveryPercent: 50, stores: { counting: shared } });
    assert.equal(shared.read().n, writes);
  });

  test('evaluate restricts the replayed runs but keeps the others as history', () => {
    const c = fx.buildCase(fx.tempDir(), { runs: stable(6, 600) });
    const newest = new Date(fx.T0 - 60 * fx.MIN).toISOString();
    const r = replay(c, [historyStrategy], { evaluate: (entry) => entry.startedAt === newest });
    assert.equal(r.runs, 1);
    assert.equal(r.strategies.history.metrics.coverage, 1);
  });
});
