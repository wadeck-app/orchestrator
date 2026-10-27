'use strict';

// Edges of the progress engine: the contract a strategy owes, the "not available" log and store, the auto selector's
// strategy id, the oldest of several open runs and which setting wins over which. Strategies are stubs and the clock
// is the fixed T0 of the fixtures.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { selectAuto } = require('../src/progress/engine');
const { T0, open, usable, job, context, estimate: estimateProgress } = require('./helpers/progress-fixtures');

const now = () => new Date(T0);
const stamp = new Date(T0).toISOString();

function stub(id, estimate) {
  return { id, version: 1, validateOptions: () => ({ ok: true, value: undefined }), estimate };
}

function answer(over) {
  return { strategyId: 's', progress: 0.5, etaAt: null, confidence: 'high', confidenceScore: 1, reason: 'fine', serverNow: stamp, ...over };
}

// One running job whose only candidate is `strategy`.
function run(strategy, jobExtra = {}) {
  const logged = [];
  const result = estimateProgress({
    jobs: [job({ id: 'a', ...jobExtra })], history: { a: [open(T0, 60)] }, now,
    log: (line) => logged.push(line), strategies: () => [strategy],
  });
  return { estimate: result.a, logged };
}

describe('the contract a strategy owes', () => {
  const violations = [
    ['a NaN progress', { progress: NaN }, /progress NaN is out of range/],
    ['a negative progress', { progress: -0.1 }, /progress -0\.1 is out of range/],
    ['a progress above 1', { progress: 1.0001 }, /out of range/],
    ['a progress that is a string', { progress: '0.5' }, /out of range/],
    ['no progress and an empty reason', { progress: null, confidence: 'none', reason: '' }, /progress is null without a reason/],
    ['no progress and a blank reason', { progress: null, confidence: 'none', reason: '   ' }, /progress is null without a reason/],
    ['an etaAt that is not a date', { etaAt: 'soon' }, /etaAt "soon" is not a date/],
  ];
  for (const [name, over, message] of violations) {
    test(`${name} becomes a reasoned "no estimate", logged once`, () => {
      const { estimate, logged } = run(stub('bad', () => answer(over)));

      assert.equal(estimate.progress, null);
      assert.equal(estimate.etaAt, null);
      assert.equal(estimate.confidence, 'none');
      assert.equal(estimate.strategyId, 'bad');
      assert.match(estimate.reason, /strategy bad failed/);
      assert.match(estimate.reason, message);
      assert.match(estimate.reason, /orch logs/);
      assert.equal(logged.length, 1);
      assert.match(logged[0], /job a/);
    });
  }

  test('the limits themselves are valid: progress 0 and progress 1 are accepted untouched', () => {
    for (const progress of [0, 1]) {
      const { estimate, logged } = run(stub('edge', () => answer({ progress })));
      assert.equal(estimate.progress, progress);
      assert.deepEqual(logged, []);
    }
  });

  test('no progress with a reason is a legitimate answer, kept as is', () => {
    const { estimate } = run(stub('quiet', () => answer({ progress: null, confidence: 'none', reason: 'nothing to say yet' })));
    assert.equal(estimate.progress, null);
    assert.match(estimate.reason, /nothing to say yet/);
  });

  test('a thrown non-Error still gives a reason', () => {
    const { estimate } = run(stub('odd', () => { throw 'plain string'; }));
    assert.match(estimate.reason, /strategy odd failed: plain string/);
  });
});

describe('selectAuto: the strategy id of "no estimate"', () => {
  const none = (id) => stub(id, () => answer({ strategyId: id, progress: null, confidence: 'none', confidenceScore: 0, reason: `${id} has nothing` }));
  const ctx = context({ history: [] });

  test('with one candidate the id of that candidate is reported', () => {
    assert.equal(selectAuto([none('only')], ctx).strategyId, 'only');
  });

  test('with several candidates there is no single culprit: the id is null', () => {
    const e = selectAuto([none('one'), none('two')], ctx);
    assert.equal(e.strategyId, null);
    assert.equal(e.progress, null);
    assert.equal(e.confidence, 'none');
  });

  test('with no candidate at all it answers "no estimate" instead of throwing', () => {
    const e = selectAuto([], ctx);
    assert.equal(e.strategyId, null);
    assert.equal(e.progress, null);
    assert.equal(e.confidence, 'none');
    assert.equal(e.serverNow, stamp);
  });

  test('a candidate that breaks the contract is skipped and the next one answers', () => {
    const logged = [];
    const broken = stub('broken', () => answer({ progress: NaN }));
    const good = stub('good', () => answer({ strategyId: 'good', progress: 0.3, reason: 'ok' }));

    const e = selectAuto([broken, good], ctx, (l) => logged.push(l));

    assert.equal(e.strategyId, 'good');
    assert.match(e.reason, /^auto: good \(ok\); skipped broken: strategy broken failed/);
    assert.equal(logged.length, 1);
  });
});

describe('estimateProgress: which run and which setting', () => {
  test('several open runs of one job: the oldest is estimated, whatever the order they were recorded in', () => {
    const seen = [];
    const spy = stub('spy', (ctx) => { seen.push(ctx.run); return answer(); });
    const newer = open(T0, 60, { pid: 11 });
    const oldest = open(T0, 500, { pid: 22 });
    const middle = open(T0, 200, { pid: 33 });

    for (const history of [[newer, oldest, middle], [middle, newer, oldest], [oldest, middle, newer]]) {
      estimateProgress({ jobs: [job({ id: 'a' })], history: { a: history }, now, strategies: () => [spy] });
    }

    assert.equal(seen.length, 3);
    for (const r of seen) {
      assert.deepEqual(r, { startedAt: oldest.startedAt, pid: 22 });
    }
  });

  test('closed runs never count as the run being estimated', () => {
    const seen = [];
    const spy = stub('spy', (ctx) => { seen.push(ctx.run.pid); return answer(); });
    estimateProgress({ jobs: [job({ id: 'a' })], history: { a: [...usable(3, 600), open(T0, 5, { pid: 77 })] }, now, strategies: () => [spy] });
    assert.deepEqual(seen, [77]);
  });

  test('progress off wins over a job without timeout, and no strategy is asked', () => {
    let asked = 0;
    const spy = stub('spy', () => { asked++; return answer(); });

    const e = estimateProgress({
      jobs: [job({ id: 'a', progress: 'off', timeoutSeconds: 0 })], history: { a: [open(T0, 60)] }, now, strategies: () => [spy],
    }).a;

    assert.equal(asked, 0);
    assert.equal(e.progress, null);
    assert.match(e.reason, /progress is off for this job/);
    assert.match(e.reason, /orch edit a --progress auto/);
    assert.doesNotMatch(e.reason, /no timeout/);
  });

  test('a job without timeout says so, whatever strategy it names', () => {
    let asked = 0;
    const spy = stub('spy', () => { asked++; return answer(); });

    const e = estimateProgress({
      jobs: [job({ id: 'a', progress: 'spy', timeoutSeconds: 0 })], history: { a: [open(T0, 60)] }, now, strategies: () => [spy],
    }).a;

    assert.equal(asked, 0);
    assert.match(e.reason, /^long-running$/);
  });

  test('a job that is off and not running is absent, not answered', () => {
    const result = estimateProgress({ jobs: [job({ id: 'a', progress: 'off' })], history: { a: usable(3, 600) }, now });
    assert.deepEqual(result, {});
  });

  test('an explicit strategy this daemon does not know says what is registered and the fix', () => {
    const e = estimateProgress({
      jobs: [job({ id: 'a', progress: 'from-the-future' })], history: { a: [open(T0, 60)] }, now, strategies: () => [stub('spy', () => answer())],
    }).a;

    assert.equal(e.progress, null);
    assert.match(e.reason, /"from-the-future" is set for this job but not registered/);
    assert.match(e.reason, /orch edit a --progress auto/);
  });

  test('stored options the strategy no longer accepts are refused with the fix', () => {
    const picky = { ...stub('picky', () => answer()), validateOptions: () => ({ ok: false, error: 'pattern is required' }) };

    const e = estimateProgress({
      jobs: [job({ id: 'a', progress: { strategy: 'picky', options: {} } })], history: { a: [open(T0, 60)] }, now, strategies: () => [picky],
    }).a;

    assert.equal(e.strategyId, 'picky');
    assert.match(e.reason, /stored options of progress strategy "picky" are invalid: pattern is required/);
  });

  test('an explicit strategy is asked alone, and its "no estimate" is the answer', () => {
    const asked = [];
    const quiet = stub('quiet', () => { asked.push('quiet'); return answer({ progress: null, confidence: 'none', reason: 'nothing yet' }); });
    const other = stub('other', () => { asked.push('other'); return answer(); });

    const e = estimateProgress({
      jobs: [job({ id: 'a', progress: 'quiet' })], history: { a: [open(T0, 60)] }, now, strategies: () => [other, quiet],
    }).a;

    assert.deepEqual(asked, ['quiet']);
    assert.equal(e.progress, null);
    assert.equal(e.reason, 'nothing yet');
  });
});
