'use strict';

// How often a run is sampled: 5 s unless the job says otherwise (resourceLimits.sampleSeconds). Every sample walks
// the process table, which on Windows without WMIC is a PowerShell start, so the interval is the cost of the monitor.
// Driven on the fake clock: the first sample is taken at once, the next ones one interval apart.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { assertNoProblems, makeHarness, settle } = require('./helpers/event-harness');
const { untilTrue } = require('./helpers/event-scenarios');

afterEach(assertNoProblems);

async function sampleCountAfter({ limits, schedulerOptions = {}, advanceMs }) {
  let calls = 0;
  const sampleUsage = async () => { calls++; return { cpuPct: 1, ramMb: 1 }; };
  const h = makeHarness([], { startedAgoMs: 1000, scheduler: { spawn: undefined, sampleUsage, ...schedulerOptions } });
  const release = path.join(h.dir, 'iv.release');
  const running = path.join(h.dir, 'iv.running');
  const script = path.join(h.dir, 'iv.js');
  fs.writeFileSync(script, `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(running)}, ''); setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { process.exit(0); } }, 10);`);
  h.registry.add({
    id: 'iv', type: 'cron', schedule: '0 8 * * *', label: 'Iv', enabled: true, triggerMode: 'fire-and-forget',
    command: `"${process.execPath}" "${script}"`,
    ...(limits === undefined ? {} : { resourceLimits: limits }),
  });
  await h.sched.trigger('iv');
  await untilTrue(() => fs.existsSync(running));
  await settle();
  const atStart = calls;
  await h.time.advanceAsync(advanceMs, 100);
  await settle();
  const afterAdvance = calls;
  fs.writeFileSync(release, '');
  await h.untilFinished(1);
  await settle();
  return { atStart, afterAdvance };
}

describe('the sample interval of a run', () => {
  test('is 5 seconds by default: one sample at once, none before 5 s, one at 5 s', async () => {
    const early = await sampleCountAfter({ advanceMs: 4_900 });
    assert.equal(early.atStart, 1);
    assert.equal(early.afterAdvance, 1, 'a sample before the 5 s interval');
    const onTime = await sampleCountAfter({ advanceMs: 5_000 });
    assert.equal(onTime.afterAdvance, 2);
  });

  test('is the job\'s sampleSeconds when it sets one', async () => {
    const early = await sampleCountAfter({ limits: { sampleSeconds: 10 }, advanceMs: 9_900 });
    assert.equal(early.afterAdvance, 1, 'a sample before the 10 s interval');
    const onTime = await sampleCountAfter({ limits: { sampleSeconds: 10 }, advanceMs: 10_000 });
    assert.equal(onTime.afterAdvance, 2);
  });

  test('the Scheduler option (tests) wins over the job', async () => {
    const r = await sampleCountAfter({ limits: { sampleSeconds: 10 }, schedulerOptions: { sampleIntervalMs: 1_000 }, advanceMs: 3_000 });
    assert.equal(r.afterAdvance, 4);
  });
});
