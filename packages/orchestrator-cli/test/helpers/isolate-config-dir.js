'use strict';

// Preloaded by `npm test` (node --require). A test that builds a Scheduler or a daemon without a configDir
// falls back to ORCH_CONFIG_DIR, then to ~/.config/orchestrator: the real one, where it wrote run logs,
// telemetry and resource history under made-up job ids (manual-a, svc-a, wa-scrape...) among the user's own.
// Pointing the variable at a throwaway folder makes that fallback harmless. A value already set is kept: CI and
// anyone who chose a folder on purpose are not overridden.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.ORCH_CONFIG_DIR) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-config-'));
  process.env.ORCH_CONFIG_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a process of a test may still hold a file */ }
  });
}
