'use strict';

/*
 * The synthetic fixtures of the progress tests and of the `orch progress replay` documentation.
 *
 *   node test/progress/helpers/make-fixtures.js <outDir>      writes <outDir>/<case>/{history.json,logs/jobs/<case>/*.log}
 *
 * test/progress/fixtures/ holds the committed output (test/progress/fixtures.test.js fails when it differs from a
 * fresh run of this script). Nothing here is copied from a real log: every line is made up.
 * A fixture is the engine's view of a config dir (logs + history.json); helpers/replay-fixture.js materialize()
 * adds registry.json and state.json so `ORCH_CONFIG_DIR=<dir> orch progress replay <case>` can replay it.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildCase, MIN } = require('./fixture-builder');

/** The log of a job that reads, parses, computes and writes: four lines at fixed fractions of the run. */
function pipelineLines(durationSec, salt = 0) {
  const at = (f) => Math.round(f * durationSec);
  return [
    [at(0.10), `Reading input batch${salt}`],
    [at(0.35), `Parsed ${1000 + salt * 13} rows`],
    [at(0.65), `Computed ${1000 + salt * 13} aggregates in ${20 + salt} ms`],
    [at(0.90), `Wrote report ${salt}`],
  ];
}

/** Same, plus a counter line `step k/4` at each milestone, for the ratio strategy. */
function countedLines(durationSec, salt = 0) {
  const at = (f) => Math.round(f * durationSec);
  return [
    ...pipelineLines(durationSec, salt),
    [at(0.20), 'step 1/4'], [at(0.45), 'step 2/4'], [at(0.70), 'step 3/4'], [at(0.95), 'step 4/4'],
  ].sort((a, b) => a[0] - b[0]);
}

function runsOf(durations, { spacingMin = 120, lines = pipelineLines } = {}) {
  return durations.map((durationSec, i) => ({ agoMin: spacingMin * (i + 1), durationSec, lines: lines(durationSec, i) }));
}

const MINUTES_STABLE = [600, 605, 598, 610, 595, 602, 607, 599, 603, 601];
const SHORT = [8, 7, 9, 8, 8, 7, 9, 8];
const INPUT_DEPENDENT = [300, 900, 450, 1200, 600, 750, 360, 1000, 540, 820, 410, 960];
const HOURS = [10800, 10900, 10700, 10850, 10750, 10800];

/** name -> buildCase spec (without the job id, which is the name). */
function fixtureSpecs() {
  return {
    'minutes-stable': { runs: runsOf(MINUTES_STABLE, { lines: countedLines }) },
    'short-under-10s': { runs: runsOf(SHORT, { spacingMin: 5 }) },
    'input-dependent': { runs: runsOf(INPUT_DEPENDENT) },
    'hours-stable': { runs: runsOf(HOURS, { spacingMin: 400 }) },
    'mixed-outcomes': {
      runs: [
        ...runsOf([600, 610, 590, 605], { spacingMin: 120 }).map((r, i) => ({ ...r, agoMin: 120 * (2 * i + 1) })),
        { agoMin: 120 * 2, durationSec: 40, exitCode: 1, lines: [[20, 'Reading input batch9'], [35, 'Error: input is missing']] },
        { agoMin: 120 * 4, durationSec: 300, exitCode: null, extra: { cancelledByUser: true }, lines: [[100, 'Reading input batch9'], [250, 'Parsed 99 rows']] },
        { agoMin: 120 * 6, durationSec: 200, exitCode: null, extra: { orphaned: true }, lines: [[100, 'Reading input batch9']] },
        { agoMin: 120 * 8, durationSec: 0, exitCode: null, extra: { skipped: true }, lines: [], markers: false },
      ],
    },
  };
}

/** Writes every fixture (or the named ones) under outDir/<case>. Returns the case names written. */
function writeFixtures(outDir, only) {
  const specs = fixtureSpecs();
  const names = only ?? Object.keys(specs);
  for (const name of names) {
    if (!specs[name]) {
      throw new Error(`unknown fixture "${name}" (known: ${Object.keys(specs).join(', ')})`);
    }
    const dir = path.join(outDir, name);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    buildCase(dir, { ...specs[name], job: { id: name } });
  }
  return names;
}

module.exports = { writeFixtures, fixtureSpecs, pipelineLines, countedLines, runsOf, MINUTES_STABLE, SHORT, INPUT_DEPENDENT, HOURS, MIN };

if (require.main === module) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: node test/progress/helpers/make-fixtures.js <outDir>');
    process.exit(2);
  }
  console.log(`wrote ${writeFixtures(path.resolve(out)).join(', ')} to ${path.resolve(out)}`);
}
