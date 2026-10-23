'use strict';

// Preloaded by `npm test` (node --require). A test that builds a Scheduler or a daemon without a configDir
// falls back to ORCH_CONFIG_DIR, then to ~/.config/orchestrator: the real one, where it wrote run logs,
// telemetry and resource history under made-up job ids (manual-a, svc-a, wa-scrape...) among the user's own.
// Pointing the variable at a throwaway folder makes that fallback harmless. A value already set is kept: CI and
// anyone who chose a folder on purpose are not overridden.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-config-'));
process.on('exit', () => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a process of a test may still hold a file */ }
});

// The event publisher (@wadeck-app/queue-sdk) would push to the queue daemon found in QUEUE_CONFIG_DIR (default: the
// user's real ~/.config/queue) and run the real `queue start` when it is stopped. Every publisher built by the daemon
// code (index.ts, Scheduler and ExecManager defaults) is switched off through this variable, which only this preload
// sets; production never does. The tests of delivery build an EventPublisher themselves with `off: false`.
if (!process.env.ORCH_TEST_EVENTS_OFF) {
  process.env.ORCH_TEST_EVENTS_OFF = '1';
}

if (!process.env.QUEUE_CONFIG_DIR) {
  process.env.QUEUE_CONFIG_DIR = path.join(dir, 'no-queue');
}

if (!process.env.ORCH_CONFIG_DIR) {
  process.env.ORCH_CONFIG_DIR = dir;
}

// A daemon started by a test (config-dir.test.js starts the real bundle) registers its module with app-core at
// start. Left alone it finds the user's live ~/.config/app-core and registers a manifest that lives in the test's
// throwaway dir; the test then deletes it and the dashboard loses its orchestrator tab. A folder that does not
// exist makes the daemon log "app-core is not installed" and register nothing.
if (!process.env.APP_CORE_CONFIG_DIR) {
  process.env.APP_CORE_CONFIG_DIR = path.join(dir, 'no-app-core');
}
