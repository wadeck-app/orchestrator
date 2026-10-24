'use strict';

// Shared builders for the progress tests: runs with a start and a duration, and a fixed clock.
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const MIN = 60_000;

/** A finished run that started `agoMin` minutes before T0 and lasted `durationSec`. Override fields with `extra`. */
function finished(agoMin, durationSec, extra = {}) {
  const start = T0 - agoMin * MIN;
  return {
    startedAt: new Date(start).toISOString(),
    finishedAt: new Date(start + durationSec * 1000).toISOString(),
    exitCode: 0,
    pid: 1,
    ...extra,
  };
}

/** A run still open, started `elapsedSec` seconds before `now`. */
function open(now, elapsedSec, extra = {}) {
  return { startedAt: new Date(now - elapsedSec * 1000).toISOString(), exitCode: null, pid: 2, ...extra };
}

/** n usable runs of `durationSec`, newest first, spaced one hour apart. */
function usable(n, durationSec) {
  return Array.from({ length: n }, (_, i) => finished(60 * (i + 2), durationSec));
}

function job(extra = {}) {
  return { id: 'j', type: 'cron', command: 'x', schedule: '0 * * * *', enabled: true, timeoutSeconds: 300, ...extra };
}

/**
 * A ProgressContext for a strategy test over a run history only: the logs are real but empty (a temp config dir with
 * no log file), the store is in memory. For log-based cases use test/progress/helpers/fixture-builder.js.
 */
function context({ history, now = T0, jobExtra = {}, runElapsedSec = 60 } = {}) {
  const { createLogCorpus } = require('../../src/progress/log-corpus');
  const { tempDir, memoryStore } = require('../progress/helpers/fixture-builder');
  const openRun = open(now, runElapsedSec);
  const all = [openRun, ...history];
  const j = job(jobExtra);
  const configDir = tempDir();
  return {
    job: j,
    configDir,
    run: { startedAt: openRun.startedAt, pid: openRun.pid },
    history: all,
    logs: createLogCorpus({ configDir, jobId: j.id, history: all, currentStartedAt: openRun.startedAt }),
    now: () => new Date(now),
    options: undefined,
    store: memoryStore(),
  };
}

/** estimateProgress with a temp config dir, for tests that only care about history. */
function estimate(input) {
  const { estimateProgress } = require('../../src/progress/engine');
  const { tempDir } = require('../progress/helpers/fixture-builder');
  return estimateProgress({ configDir: tempDir(), ...input });
}

module.exports = { T0, MIN, finished, open, usable, job, context, estimate };

// Every test file that builds temp config dirs through these helpers cleans them up when it ends.
require('node:test').after(require('../progress/helpers/fixture-builder').cleanupTemp);
