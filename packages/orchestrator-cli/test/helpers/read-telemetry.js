'use strict';

// Test-only oracle: what a job's telemetry files hold, oldest first (the older file, then the live one). The
// product reads these files with run-telemetry.ts; tests that check what the writer produced read the raw
// lines instead, so they do not depend on that reader's grouping and sampling.
const fs = require('node:fs');

const { telemetryPath, rotatedPath } = require('../../src/job-telemetry');

function linesOf(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l));
}

function readTelemetryLines(configDir, jobId) {
  return [...linesOf(rotatedPath(configDir, jobId)), ...linesOf(telemetryPath(configDir, jobId))];
}

module.exports = { readTelemetryLines };
