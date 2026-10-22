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

/** A ProgressContext for a strategy test; the logs and the store are the "not available" ones of this slice. */
function context({ history, now = T0, jobExtra = {}, runElapsedSec = 60 } = {}) {
  const { NO_LOGS, NO_STORE } = require('../../src/progress/engine');
  const openRun = open(now, runElapsedSec);
  return {
    job: job(jobExtra),
    run: { startedAt: openRun.startedAt, pid: openRun.pid },
    history: [openRun, ...history],
    logs: NO_LOGS,
    now: () => new Date(now),
    options: undefined,
    store: NO_STORE,
  };
}

module.exports = { T0, MIN, finished, open, usable, job, context };
