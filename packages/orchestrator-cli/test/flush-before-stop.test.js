'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { flushBeforeStop } = require('../src/flush-before-stop');

/*
 * The daemon kit's onShutdown hook is synchronous, so the events in flight can only be awaited BEFORE the kit is
 * asked to stop. The kit's signal, /quit and idle paths all call `handle.stop(...)`: flushBeforeStop wraps it.
 */

function fakeHandle() {
  const calls = [];
  return { calls, port: 1, stop: async (reason) => { calls.push(['stop', reason]); } };
}

describe('flushBeforeStop', () => {
  test('the kit is asked to stop only once the pending flush has settled', async () => {
    const handle = fakeHandle();
    let release;
    const pending = new Promise((r) => { release = r; });
    flushBeforeStop(handle, () => { handle.calls.push(['flush']); return pending; });

    const stopping = handle.stop('signal');
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(handle.calls, [['flush']], 'stop ran while the flush was still pending');

    release();
    await stopping;
    assert.deepEqual(handle.calls, [['flush'], ['stop', 'signal']]);
  });

  test('a flush that fails does not prevent the stop, and the failure is logged', async () => {
    const handle = fakeHandle();
    const lines = [];
    flushBeforeStop(handle, () => Promise.reject(new Error('boom')), (l) => lines.push(l));
    await handle.stop('command');
    assert.deepEqual(handle.calls, [['stop', 'command']]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /boom/);
  });

  test('a second stop does not flush again', async () => {
    const handle = fakeHandle();
    let flushes = 0;
    flushBeforeStop(handle, async () => { flushes++; });
    await handle.stop('signal');
    await handle.stop('signal');
    assert.equal(flushes, 1);
  });
});
