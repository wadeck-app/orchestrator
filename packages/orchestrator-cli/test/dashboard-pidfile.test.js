'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { classifyDashboard } = require('../src/dashboard-pidfile');

const ALIVE = () => true;
const DEAD = () => false;

describe('classifyDashboard', () => {
  test('reports stopped when there is no pid file', () => {
    assert.deepEqual(classifyDashboard(null, ALIVE), { kind: 'stopped' });
  });

  test('reports running when the recorded pid is alive', () => {
    const raw = JSON.stringify({ port: 47951, pid: 1234, startedAt: '2026-09-16T08:00:00.000Z' });
    assert.deepEqual(classifyDashboard(raw, ALIVE), {
      kind: 'running',
      info: { port: 47951, pid: 1234, startedAt: '2026-09-16T08:00:00.000Z' },
    });
  });

  // The bug this guards: `orch server status` said "stale -- run orch server stop
  // to clean up" while `orch server stop` failed with ESRCH and left the file in
  // place, so `orch server start` reported "already running" against a dead pid
  // forever. Callers need stale to be distinguishable from running.
  test('reports stale when the recorded pid is dead', () => {
    const raw = JSON.stringify({ port: 47951, pid: 26560 });
    assert.deepEqual(classifyDashboard(raw, DEAD), {
      kind: 'stale',
      info: { port: 47951, pid: 26560, startedAt: undefined },
    });
  });

  test('reports corrupt for unparseable content rather than throwing', () => {
    assert.deepEqual(classifyDashboard('not json', ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard('', ALIVE), { kind: 'corrupt' });
  });

  // Valid JSON that is not an object. Every other case here parses to an object, so the guard's
  // null-and-scalar branch was never reached: mutating it away left the suite green, while in
  // reality `'port' in value` throws a TypeError and `orch server status` dies on a one-line
  // pidfile instead of reporting a corrupt one.
  test('reports corrupt for valid JSON that is not an object', () => {
    assert.deepEqual(classifyDashboard('null', ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard('42', ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard('"47951"', ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard('[]', ALIVE), { kind: 'corrupt' });
  });

  test('reports corrupt when the pid is missing or not a number', () => {
    assert.deepEqual(classifyDashboard(JSON.stringify({ port: 47951 }), ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard(JSON.stringify({ port: 47951, pid: 'x' }), ALIVE), { kind: 'corrupt' });
  });

  test('reports corrupt when the port is missing or not a number', () => {
    assert.deepEqual(classifyDashboard(JSON.stringify({ pid: 1234 }), ALIVE), { kind: 'corrupt' });
    assert.deepEqual(classifyDashboard(JSON.stringify({ port: 'x', pid: 1234 }), ALIVE), { kind: 'corrupt' });
  });

  test('only probes liveness for a well-formed file', () => {
    const probed = [];
    const spy = (pid) => { probed.push(pid); return false; };
    classifyDashboard('not json', spy);
    assert.deepEqual(probed, []);
    classifyDashboard(JSON.stringify({ port: 1, pid: 99 }), spy);
    assert.deepEqual(probed, [99]);
  });
});
