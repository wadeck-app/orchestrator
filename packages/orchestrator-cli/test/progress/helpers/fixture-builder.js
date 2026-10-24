'use strict';

/*
 * Synthetic fixtures for the progress tests. Never copy a real log here.
 *
 * A fixture is a config dir laid out as the daemon leaves it:
 *   <dir>/history.json                      { job, history }  (history = RuntimeEntry[], newest first)
 *   <dir>/logs/jobs/<id>/<id>-<stamp>.log   one '[YYYY-MM-DD HH:MM:SS] text' file per run, as RunLogger writes
 * so `dir` is directly a `configDir` for the engine, the log corpus and the replay harness.
 *
 * buildCase(dir, spec) writes one; loadFixture(dir) reads one back (also works on a committed fixture folder).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { progressWriter } = require('../../../src/progress/async-writer');

const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const MIN = 60_000;

const temps = [];

/** A fresh temp dir, removed by cleanupTemp() (register it with `after`). */
function tempDir(prefix = 'orch-progress-fx-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

// Learned-data saves are asynchronous: wait for them, or one could land in a folder that is already gone.
async function cleanupTemp() {
  await progressWriter.whenIdle();
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * Runs a writer's retry waits to the end on a FakeTime: yields to the disk, then moves the clock, until the writer is
 * idle. The result does not depend on how long the real disk takes.
 */
async function drainWriter(writer, time) {
  let idle = false;
  void writer.whenIdle().then(() => { idle = true; });
  while (!idle) {
    await new Promise(resolve => setImmediate(resolve));
    time.advance(1000);
  }
}

function stamp(ms) {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** The file name RunLogger gives a run starting at `startedAt` (logger.ts runLogPath). */
function runLogName(jobId, startedAt) {
  return `${jobId}-${startedAt.replace(/:/g, '-').slice(0, 19)}.log`;
}

/** Lines evenly spread: `count` lines, line i at i/count of `durationSec`, text from `fmt(i, count)`. */
function ramp(count, durationSec, fmt) {
  return Array.from({ length: count }, (_, i) => [Math.round(((i + 1) / count) * durationSec * 0.98), fmt(i + 1, count)]);
}

function formatLog(startMs, lines) {
  return lines.map(([offsetSec, text]) => `[${stamp(startMs + offsetSec * 1000)}] ${text}`).join('\n') + (lines.length ? '\n' : '');
}

/**
 * spec:
 *   job      overrides of the job (id defaults to 'j')
 *   runs     past runs: { agoMin (or agoMs), durationSec, exitCode = 0, lines = [[offsetSec, text]], extra = {},
 *              inHistory = true (false: log only), log = true (false: no file), markers = true, raw = string (file content as is) }
 *   current  { elapsedSec, lines, pid = 2, raw } the open run, started elapsedSec before `now`
 *   now      defaults to T0
 *   legacyDaily  also write a '<id>-YYYY-MM-DD.log' daily file
 */
function buildCase(dir, spec = {}) {
  const now = spec.now ?? T0;
  const job = { id: 'j', type: 'cron', command: 'x', schedule: '0 * * * *', enabled: true, timeoutSeconds: 300, ...spec.job };
  const logDir = path.join(dir, 'logs', 'jobs', job.id);
  fs.mkdirSync(logDir, { recursive: true });
  const history = [];

  for (const run of spec.runs ?? []) {
    // agoMs: an exact offset, for runs that must start within the same second.
    const startMs = now - (run.agoMs ?? run.agoMin * MIN);
    const startedAt = new Date(startMs).toISOString();
    const exitCode = Object.prototype.hasOwnProperty.call(run, "exitCode") ? run.exitCode : 0;
    const entry = {
      startedAt,
      finishedAt: new Date(startMs + run.durationSec * 1000).toISOString(),
      exitCode,
      pid: 1,
      ...run.extra,
    };
    if (run.inHistory !== false) {
      history.push(entry);
    }
    if (run.log !== false) {
      let content;
      if (run.raw !== undefined) {
        content = run.raw;
      } else {
        const body = [...(run.lines ?? [])];
        if (run.markers !== false) {
          body.unshift([0, '[job:started] pid=1 triggeredBy=cron']);
          body.push([run.durationSec, `[job:finished] exitCode=${exitCode === null ? 1 : exitCode} duration=${run.durationSec}s`]);
        }
        content = formatLog(startMs, body);
      }
      fs.writeFileSync(path.join(logDir, runLogName(job.id, startedAt)), content);
    }
  }

  let currentStartedAt = null;
  if (spec.current) {
    const startMs = now - spec.current.elapsedSec * 1000;
    currentStartedAt = new Date(startMs).toISOString();
    history.unshift({ startedAt: currentStartedAt, exitCode: null, pid: spec.current.pid ?? 2 });
    const content = spec.current.raw !== undefined
      ? spec.current.raw
      : formatLog(startMs, [[0, '[job:started] pid=2 triggeredBy=cron'], ...(spec.current.lines ?? [])]);
    fs.writeFileSync(path.join(logDir, runLogName(job.id, currentStartedAt)), content);
  }

  if (spec.legacyDaily) {
    fs.writeFileSync(path.join(logDir, `${job.id}-${new Date(now).toISOString().slice(0, 10)}.log`), `[${stamp(now)}] old daily file line\n`);
  }

  history.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ job, history }, null, 2));
  return { configDir: dir, job, history, now, currentStartedAt, logDir };
}

function loadFixture(dir) {
  const file = path.join(dir, 'history.json');
  if (!fs.existsSync(file)) {
    throw new Error(`fixture ${dir} has no history.json (a fixture is <dir>/history.json + <dir>/logs/jobs/<id>/*.log)`);
  }
  const { job, history } = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { configDir: dir, job, history, logDir: path.join(dir, 'logs', 'jobs', job.id) };
}

/**
 * The ProgressContext of a built case, for a strategy test. `store` is an in-memory store unless given.
 * Overrides: options, now (ms), store, jobExtra.
 */
function contextOf(fx, overrides = {}) {
  const { createLogCorpus } = require('../../../src/progress/log-corpus');
  const now = overrides.now ?? fx.now ?? T0;
  const job = { ...fx.job, ...overrides.jobExtra };
  const open = fx.history.filter(e => !e.finishedAt).sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  if (!open) {
    throw new Error('contextOf needs a fixture with a current (open) run: pass spec.current');
  }
  return {
    job,
    run: { startedAt: open.startedAt, pid: open.pid },
    history: fx.history,
    logs: createLogCorpus({ configDir: fx.configDir, jobId: job.id, history: fx.history, currentStartedAt: open.startedAt }),
    now: () => new Date(now),
    options: overrides.options,
    store: overrides.store ?? memoryStore(),
    configDir: fx.configDir,
  };
}

function memoryStore() {
  let data;
  let meta;
  return {
    read: () => data,
    write: (d, m) => { data = d; meta = m; },
    meta: () => meta,
    invalidate: () => { data = undefined; meta = undefined; },
  };
}

module.exports = { drainWriter, T0, MIN, tempDir, cleanupTemp, buildCase, loadFixture, contextOf, memoryStore, ramp, formatLog, runLogName, stamp };
