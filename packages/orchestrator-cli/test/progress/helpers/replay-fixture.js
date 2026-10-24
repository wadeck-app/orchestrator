'use strict';

/*
 * Test helper for `orch progress replay`: runs the very code the command runs (buildReplayReport) over a fixture
 * folder, and turns a fixture into a real config dir (registry.json + state.json + logs) so the command itself can
 * be pointed at it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildReplayReport } = require('../../../src/progress/replay-report');
const { loadFixture, tempDir } = require('./fixture-builder');

/** The replay report of a fixture folder (test/progress/fixtures/<case>), optionally for one strategy. */
function replayFixture(dir, { strategy, sampleEveryPercent } = {}) {
  const { job, history } = loadFixture(dir);
  return buildReplayReport({ job, history, configDir: dir, strategyId: strategy, sampleEveryPercent });
}

/** A temp config dir holding the fixture as the daemon would have left it. Cleaned by fixture-builder cleanupTemp. */
function materialize(fixtureDir) {
  const { job, history, logDir } = loadFixture(fixtureDir);
  const dir = tempDir('orch-replay-cfg-');
  fs.writeFileSync(path.join(dir, 'registry.json'), JSON.stringify({ version: 1, jobs: [job] }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ jobs: { [job.id]: history } }));
  fs.cpSync(logDir, path.join(dir, 'logs', 'jobs', job.id), { recursive: true });
  return { configDir: dir, job, history };
}

module.exports = { replayFixture, materialize };
