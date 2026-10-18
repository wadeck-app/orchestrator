'use strict';

// The blue "running" icon says "something is working right now". A job declared with no timeout (timeoutSeconds 0,
// "for a process that must stay up, e.g. a dev server") is not working in that sense: it is meant to run for ever,
// so showing it as running for ever leaves the icon blue on every machine that has a server job. The icon shows it
// for a few seconds, which is when a start is worth noticing, and then stops counting it.
const { test, describe, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { TrayManager } = require('../src/tray-manager');

function makeManager(jobs) {
  const scheduler = Object.assign(new EventEmitter(), { stop: () => {}, runningCount: () => 0 });
  const registry = { list: () => Object.values(jobs), get: (id) => jobs[id] ?? null };
  const mgr = new TrayManager('/tmp/fake-config', scheduler, { getAll: () => ({}) }, registry, '0.0.0-test', undefined, null);
  return mgr;
}

const tooltip = (mgr) => mgr._buildMenu().tooltip;

afterEach(() => { mock.timers.reset(); });

describe('the running icon', () => {
  test('a job with a timeout makes the tray running, and stays so while it runs', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ job: { id: 'job', timeoutSeconds: 300 } });

    mgr._jobStarted('job');
    mock.timers.tick(60_000);

    assert.match(tooltip(mgr), /1 job\(s\) running/);
  });

  test('a job with the default timeout (unset) is a normal job', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ job: { id: 'job' } });

    mgr._jobStarted('job');
    mock.timers.tick(60_000);

    assert.match(tooltip(mgr), /1 job\(s\) running/);
  });

  test('a long-running job (no timeout) shows as running at first', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ server: { id: 'server', timeoutSeconds: 0 } });

    mgr._jobStarted('server');

    assert.match(tooltip(mgr), /1 job\(s\) running/);
  });

  test('and stops showing after five seconds, since it is meant to keep running', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ server: { id: 'server', timeoutSeconds: 0 } });

    mgr._jobStarted('server');
    mock.timers.tick(4_999);
    assert.match(tooltip(mgr), /running/, 'it must still show just before the five seconds');
    mock.timers.tick(2);

    assert.equal(tooltip(mgr), 'Orchestrator - all jobs OK');
  });

  test('a long-running job leaves the icon of other jobs that are really running alone', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ server: { id: 'server', timeoutSeconds: 0 }, batch: { id: 'batch', timeoutSeconds: 600 } });

    mgr._jobStarted('server');
    mgr._jobStarted('batch');
    mock.timers.tick(6_000);

    assert.match(tooltip(mgr), /1 job\(s\) running/);
  });

  test('a long-running job that ends within the five seconds is cleared at once and not again later', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ server: { id: 'server', timeoutSeconds: 0 }, batch: { id: 'batch', timeoutSeconds: 600 } });

    mgr._jobStarted('server');
    mgr._jobEnded('server');
    mgr._jobStarted('batch');
    mock.timers.tick(6_000);

    assert.match(tooltip(mgr), /1 job\(s\) running/, 'the batch job must still count');
  });

  test('a job the registry no longer knows is treated as a normal job', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({});

    mgr._jobStarted('gone');
    mock.timers.tick(60_000);

    assert.match(tooltip(mgr), /1 job\(s\) running/);
  });

  test('starting a long-running job again restarts its five seconds', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const mgr = makeManager({ server: { id: 'server', timeoutSeconds: 0 } });

    mgr._jobStarted('server');
    mock.timers.tick(6_000);
    mgr._jobStarted('server');

    assert.match(tooltip(mgr), /1 job\(s\) running/);
    mock.timers.tick(6_000);
    assert.equal(tooltip(mgr), 'Orchestrator - all jobs OK');
  });
});
