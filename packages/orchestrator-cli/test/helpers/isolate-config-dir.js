'use strict';

// Preloaded by `npm test` (node --require). A test that builds a Scheduler or a daemon without a configDir
// falls back to ORCH_CONFIG_DIR, then to ~/.config/orchestrator: the real one, where it wrote run logs,
// telemetry and resource history under made-up job ids (manual-a, svc-a, wa-scrape...) among the user's own.
// Pointing the variable at a throwaway folder makes that fallback harmless. A value already set is kept: CI and
// anyone who chose a folder on purpose are not overridden.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// One temp root for the whole run. Tests make their folders with mkdtemp(os.tmpdir()) and most never remove them: the
// suite used to leave about 47 000 orch-* folders in the OS temp dir. TEMP/TMP/TMPDIR now point at a root that this
// preload makes once (the process that starts the run) and removes when that process exits, so whatever a test forgot
// goes with it. Every process of the run inherits the variables and shares the root (ORCH_TEST_TMP_ROOT marks it);
// only the process that made it removes it. A job a test left running can still hold a file there: the next
// `npm test` sweeps what is left (scripts/clean-test-temp.cjs).
const ownsRoot = !process.env.ORCH_TEST_TMP_ROOT;
if (ownsRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-root-'));
  process.env.ORCH_TEST_TMP_ROOT = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  process.env.TMPDIR = root;
  process.on('exit', () => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* held by a left-over process: the next run sweeps it */ }
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-config-'));

// The event publisher (@wadeck-app/queue-sdk) would push to the queue daemon found in QUEUE_CONFIG_DIR (default: the
// user's real ~/.config/queue) and run the real `queue start` when it is stopped. Every publisher built by the daemon
// code (index.ts, Scheduler and ExecManager defaults) is switched off through the SDK's own variable, QUEUE_SDK_OFF=1, which
// is for development runs and tests only (the SDK announces it once when it is set). The delivery tests set it to 0 themselves.
if (!process.env.QUEUE_SDK_OFF) {
  process.env.QUEUE_SDK_OFF = '1';
}

// The progress strategies run user regexes under a wall-clock budget (500 ms). With every core busy a sound pattern on a
// trivial line ran out of it (seen: log-declared tests answering "exceeded the 500 ms match budget"), so the suite runs
// with a budget no starved process reaches. The tests of the budget itself pass their own (createMatcher's options).
if (!process.env.ORCH_PROGRESS_MATCH_BUDGET_MS) {
  process.env.ORCH_PROGRESS_MATCH_BUDGET_MS = '60000';
}

// No test starts a tray. A daemon a test launches would spawn a real orchestrator-tray.exe, and the test then kills the
// daemon tree by force, which leaves a ghost icon in the Windows taskbar (15-25 on 2026-10-25). The daemon reads this in
// TrayManager.start and logs one line saying the tray is off. Children inherit it. Forced to 1, even if the caller set it
// otherwise: a run that can start trays is the bug. The few tests of the real TrayManager set it to 0 around a fake binary.
process.env.ORCH_NO_TRAY = '1';

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

// No test reaches the developer's global npm or the real registry. The updater, UpdateManager, `orch cli update` and the
// tray's `npm view` all run npm; an `npm install -g` a test started was killed halfway on 2026-10-24 and left the global
// CLI uninstalled. A throwaway global prefix, cache and npm config files, and a registry nothing listens on, for every
// process of the run. Inherited npm_config_* are dropped (`npm test` exports the caller's whole npm config that way); a deliberate choice is ORCH_TEST_NPM_PREFIX / ORCH_TEST_NPM_REGISTRY. The config files are always ours
// (a real one carries the scope registry and the token). Guarded by test/npm-isolation-env.test.js and test/npm-isolation-registry.test.js.
{
  const { applySuiteNpmGuard } = require('./isolated-npm-env');
  const npmRoot = path.join(dir, 'npm');
  fs.mkdirSync(npmRoot, { recursive: true });
  applySuiteNpmGuard(npmRoot);
}

// A leaked updater switch must not turn a test's daemon or CLI into an explicit update request.
delete process.env.UPDATER_FORCE;
