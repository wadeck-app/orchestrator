'use strict';

// The engine: which jobs get an estimate, the auto selector, and the guard around a strategy that misbehaves.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { selectAuto } = require('../src/progress/engine');
const { T0, finished, open, usable, job, estimate: estimateProgress } = require('./helpers/progress-fixtures');

const now = () => new Date(T0);
const stamp = new Date(T0).toISOString();

function stub(id, result) {
  return { id, version: 1, validateOptions: () => ({ ok: true, value: undefined }), estimate: result };
}

describe('estimateProgress', () => {
  test('answers only for jobs with an open run', () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b' })];
    const history = { a: [open(T0, 60), ...usable(5, 600)], b: usable(5, 600) };

    const result = estimateProgress({ jobs, history, now });

    assert.deepEqual(Object.keys(result), ['a']);
    assert.equal(result.a.strategyId, 'history');
    assert.match(result.a.reason, /^auto: history/);
  });

  test('a long-running job (no timeout) gets no progress, with the reason', () => {
    const jobs = [job({ id: 'a', timeoutSeconds: 0 })];
    const result = estimateProgress({ jobs, history: { a: [open(T0, 60), ...usable(5, 600)] }, now });
    assert.equal(result.a.progress, null);
    assert.equal(result.a.confidence, 'none');
    assert.match(result.a.reason, /no completion expected \(no timeout\)/);
  });

  test('a manual job behaves like the others', () => {
    const jobs = [job({ id: 'a', type: 'manual', schedule: undefined })];
    const result = estimateProgress({ jobs, history: { a: [open(T0, 300), ...usable(5, 600)] }, now });
    assert.equal(result.a.progress, 0.5);
  });

  test('jobIds restricts the answer', () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b' })];
    const history = { a: [open(T0, 60), ...usable(5, 600)], b: [open(T0, 60), ...usable(5, 600)] };
    assert.deepEqual(Object.keys(estimateProgress({ jobs, history, now, jobIds: ['b'] })), ['b']);
  });

  test('a job with fewer than 3 usable runs says so', () => {
    const result = estimateProgress({ jobs: [job({ id: 'a' })], history: { a: [open(T0, 60), finished(60, 100)] }, now });
    assert.equal(result.a.progress, null);
    assert.match(result.a.reason, /needs 3 usable runs, has 1/);
    assert.match(result.a.reason, /^auto: /);
  });

  test('a throwing strategy yields a reasoned null for that job and the others still answer', () => {
    const boom = stub('boom', () => { throw new Error('kaput'); });
    const logged = [];
    const jobs = [job({ id: 'a' }), job({ id: 'b' })];
    const history = { a: [open(T0, 60)], b: [open(T0, 300), ...usable(5, 600)] };

    const result = estimateProgress({
      jobs, history, now, log: (l) => logged.push(l),
      strategies: (j) => (j.id === 'a' ? [boom] : undefined),
    });

    assert.equal(result.a.progress, null);
    assert.equal(result.a.confidence, 'none');
    assert.match(result.a.reason, /boom/);
    assert.match(result.a.reason, /kaput/);
    assert.match(result.a.reason, /orch logs/);
    assert.equal(logged.length, 1);
    assert.equal(result.b.progress, 0.5);
  });

  test('a strategy returning an out-of-range progress is rejected like a throw', () => {
    const bad = stub('bad', () => ({
      strategyId: 'bad', progress: 1.5, etaAt: null, confidence: 'high', confidenceScore: 1, reason: 'x', serverNow: stamp,
    }));
    const result = estimateProgress({ jobs: [job({ id: 'a' })], history: { a: [open(T0, 1)] }, now, log: () => {}, strategies: () => [bad] });
    assert.equal(result.a.progress, null);
    assert.match(result.a.reason, /bad/);
    assert.match(result.a.reason, /out of range/);
  });
});

describe('selectAuto', () => {
  const none = (id) => stub(id, () => ({
    strategyId: id, progress: null, etaAt: null, confidence: 'none', confidenceScore: 0, reason: `${id} has nothing`, serverNow: stamp,
  }));
  const ok = (id, p) => stub(id, () => ({
    strategyId: id, progress: p, etaAt: null, confidence: 'low', confidenceScore: 0.5, reason: id, serverNow: stamp, detail: { overdue: true },
  }));

  test('with no eligible candidate the result lists every skip reason', () => {
    const e = selectAuto([none('one'), none('two')], { now });
    assert.equal(e.progress, null);
    assert.match(e.reason, /one has nothing/);
    assert.match(e.reason, /two has nothing/);
  });

  test('chooses the first eligible candidate', () => {
    const e = selectAuto([none('zero'), ok('first', 0.2), ok('second', 0.9)], { now });
    assert.equal(e.strategyId, 'first');
    assert.match(e.reason, /^auto: first/);
    assert.match(e.reason, /zero has nothing/);
  });
});
