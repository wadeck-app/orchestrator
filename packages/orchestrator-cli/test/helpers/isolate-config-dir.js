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

// The event publisher (@wadeck-app/queue-sdk) pushes to the queue daemon found in QUEUE_CONFIG_DIR (default: the
// user's real ~/.config/queue, with the real token and history). A folder with no config.port makes every publish
// fail with a logged error instead. The SDK then runs the first `queue` on PATH with `start` to wake the daemon: a stub
// that only fails comes first, so the real CLI never starts a daemon from a test. A test that needs another `queue`
// (a fake) puts it in front of PATH itself.
const stubBin = path.join(dir, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'queue.cmd'), ['@echo the test suite blocks the real queue CLI 1>&2', '@exit /b 1', ''].join('\r\n'));
fs.writeFileSync(path.join(stubBin, 'queue'), ['#!/bin/sh', 'echo "the test suite blocks the real queue CLI" >&2', 'exit 1', ''].join('\n'), { mode: 0o755 });
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
process.env[pathKey] = stubBin + path.delimiter + (process.env[pathKey] ?? '');

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
