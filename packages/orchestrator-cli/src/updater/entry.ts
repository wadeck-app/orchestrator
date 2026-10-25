// orchestrator-updater entry point - bundled by CI as dist/orchestrator-updater.cjs.
// Spawned as a detached process by UpdateManager.scheduleBackgroundUpdate().
// Must NOT import any orchestrator runtime modules.
//
// Strategy: without-daemon + restartDaemon.
// npm install is done by Node.js (windowsHide:true) - zero terminal windows, proven by PoC.
// After successful install, writes config.restart sentinel then POST /quit so the
// Go launcher restarts the daemon with the new version.
import { runUpdater, execNpm, appendLog, readState, stateFilePath } from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveSelfCheckTarget, armSelfCheck } from './self-check-target.js';
import { getErrorMessage } from '../fsUtil.js';
import { isReleaseVersion, devBuildRefusalMessage } from '../dev-build-guard.js';
import * as http from 'node:http';
import semver from 'semver';

declare const __ORCH_VERSION__: string;

const PKG_NAME = '@wadeck-app/orchestrator-cli';
const configDir = process.env['ORCH_CONFIG_DIR'] ?? ConfigDir.get('orchestrator');
const currentVersion = typeof __ORCH_VERSION__ !== 'undefined' ? __ORCH_VERSION__ : '0.0.0-dev';

// Dev build guard, before ANY npm call or config edit. A repo-built bundle (0.2.0, or the 0.0.0-dev of an
// unbundled run) is older than every published version, so the updater would find an "update" and run
// `npm install -g` over the user's real install; killed halfway, that leaves the CLI uninstalled
// (incident 2026-10-24). Every route lands here: the daemon's startup/30-minute checks, the tray, and
// `orch cli update`. Detached with stdio ignored, so the reason goes to the log `orch logs` shows.
if (!isReleaseVersion(currentVersion)) {
  const message = `${PKG_NAME}: ${devBuildRefusalMessage(currentVersion)}`;
  appendLog(configDir, 'warn', message);
  if (process.env['UPDATER_FORCE'] === '1') {
    // Someone asked for this update: say so where they can read it, and fail.
    process.stderr.write(`[fail] ${message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

// When UPDATER_FORCE=1 (manual update from tray), shared-updater still exits early on
// autoUpdate:false. Work around by temporarily commenting out that line so runUpdater proceeds.
const isForced = process.env['UPDATER_FORCE'] === '1';
let _patchedConfigYml: { path: string; original: string } | null = null;
if (isForced) {
  const cfgPath = join(configDir, 'config.yml');
  try {
    const content = readFileSync(cfgPath, 'utf8');
    if (/^autoUpdate:\s*false/im.test(content)) {
      _patchedConfigYml = { path: cfgPath, original: content };
      writeFileSync(cfgPath, content.replace(/^(autoUpdate:\s*false)/im, '# $1'));
    }
  } catch { /* ignore -- config.yml missing or unreadable, runUpdater will handle */ }
}

/**
 * Puts config.yml back the way the user left it. Idempotent, so it is safe on every exit path:
 * under UPDATER_FORCE the autoUpdate:false line is commented out, and leaving it that way would
 * silently re-enable auto-updating a user who explicitly turned it off.
 */
function restoreConfigYml(): void {
  if (!_patchedConfigYml) {
    return;
  }
  try { writeFileSync(_patchedConfigYml.path, _patchedConfigYml.original); } catch { /* ignore */ }
  _patchedConfigYml = null;
}

// Compute the self-check command so shared-updater can verify the install and roll back.
// It also validates the repair of an interrupted install ('applying' journaled by a previous run): see armSelfCheck.
if (!process.env['UPDATER_SELF_CHECK_CMD']) {
  const interrupted = readState(stateFilePath(configDir))?.status === 'applying';
  let resolved: { ok: true; target: string } | { ok: false; reason: string };
  try {
    const npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
    resolved = resolveSelfCheckTarget(npmRoot, PKG_NAME);
  } catch (e) {
    resolved = { ok: false, reason: `cannot resolve 'npm root -g': ${getErrorMessage(e)}` };
  }
  const armed = armSelfCheck({ nodeExe: process.execPath, resolved, interrupted });
  if (armed.abort !== undefined) {
    // shared-updater treats a missing UPDATER_SELF_CHECK_CMD as "self-check passed", so carrying on would install an
    // unverified upgrade with no rollback; and arming a command whose target is absent is what caused the permanent
    // rollback loop described on resolveSelfCheckTarget. Refusing to update is recoverable; looping is not.
    // Recorded where `orch logs` can show it: this process is detached with stdio ignored.
    appendLog(configDir, 'error', `${PKG_NAME} update aborted: ${armed.abort}`);
    // Restore config.yml before leaving. Under UPDATER_FORCE the autoUpdate:false line was commented out above, and it
    // is otherwise only restored once runUpdater completes. Exiting here would leave the user's explicit "do not
    // auto-update" disabled for good, so failing closed on one axis would have silently opened another.
    restoreConfigYml();
    process.exit(1);
  }
  if (armed.note) {
    appendLog(configDir, 'warn', `${PKG_NAME} ${armed.note}`);
  }
  process.env['UPDATER_SELF_CHECK_CMD'] = armed.command;
}

/**
 * Check if the package version's Node.js engine requirements are satisfied by the current process.
 * Returns { ok: true } if compatible, or { ok: false, reason } if not.
 * Fetches package.json from npm registry and checks "engines.node" field.
 */
async function checkEngineCompatibility(pkgName: string, version: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const npmView = execNpm(['view', `${pkgName}@${version}`, 'engines.node', '--json'], { timeout: 10_000 }).trim();
    const engineSpec = JSON.parse(npmView) as string;
    if (!engineSpec) {
      return { ok: true };
    } // no engine constraint
    if (!semver.satisfies(process.version, engineSpec)) {
      return { ok: false, reason: `Node.js engine mismatch: requires ${engineSpec}, current ${process.version}` };
    }
    return { ok: true };
  } catch (err) {
    // If we can't determine engine requirements, allow the update to proceed
    // (shared-updater will catch other errors via self-check)
    return { ok: true };
  }
}

/**
 * Query GET /health on the orchestrator daemon. Returns the parsed JSON body, or null
 * if the daemon is unreachable, the request times out, or the response is not valid JSON.
 */
function queryDaemonHealth(port: number, token: string, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/health',
        headers: { Authorization: `Bearer ${token}` },
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          try {
            // violations-suppress: ts/no-unsafe-type-cast HTTP JSON parse result - runtime shape unknown, cast is intentional
            resolve(JSON.parse(body) as Record<string, unknown>);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

runUpdater({
  pkgName: PKG_NAME,
  configDir,
  currentVersion,
  strategy: 'without-daemon',
  // The daemon already owns its own spawn cadence (index.ts's 30m setInterval) -- the
  // cache.lastCheckedAt/checkIntervalMs gate this bypasses exists for callers with no schedule of
  // their own (queue, the scrapers), not for us. Setting checkInterval in config.yml to match the
  // daemon's spawn interval, instead of skipping the gate, is what let a stale build sit for days:
  // the check finishes a few seconds after each spawn, so the next spawn is always a hair short of
  // the gate and skips -- every other spawn, forever.
  skipThrottle: true,
  restartDaemon: {
    portFile: join(configDir, 'config.port'),
    healthTokenFile: join(configDir, 'health_token'),
  },
  onUpdateAvailable: async (newVersion: string) => {
    // Pre-flight check: verify Node.js engine compatibility before attempting install
    const engineCheck = await checkEngineCompatibility(PKG_NAME, newVersion);
    if (!engineCheck.ok) {
      process.stderr.write(`[orchestrator-updater] engine-check: ${engineCheck.reason}\n`);
      // Defer indefinitely - user must upgrade Node.js before we can proceed
      return { defer: true, retryIn: 24 * 60 * 60 * 1000 }; // retry in 24h
    }

    // A person clicked "update and restart" in the tray, or ran `orch cli update`. Waiting for a
    // quiet moment is right for the background timer and wrong here: they are watching, and the
    // answer they got instead was "deferred", repeated every attempt. UPDATER_FORCE already carries
    // "the user asked for this" -- it just was not consulted past the autoUpdate:false check.
    if (isForced) {
      appendLog(configDir, 'info',
        `${PKG_NAME} applying update to ${newVersion} now: explicitly requested, so the `
        + `active-jobs deferral is skipped`);
      return 'apply-now';
    }

    try {
      const portJson = readFileSync(join(configDir, 'config.port'), 'utf8');
      const { port } = JSON.parse(portJson) as { port: number };
      const token = readFileSync(join(configDir, 'health_token'), 'utf8').trim();
      const health = await queryDaemonHealth(port, token, 3_000);
      const activeJobs =
        (health !== null && typeof health['active_jobs'] === 'number' && health['active_jobs']) ||
        (health !== null && typeof health['running'] === 'number' && health['running']) ||
        0;
      if (activeJobs > 0) {
        // Jobs are running: hold off rather than restarting the daemon under them. Logged, because
        // a silent deferral is indistinguishable from an update that simply never happened.
        appendLog(configDir, 'info',
          `${PKG_NAME} deferring update to ${newVersion} for 60s: ${activeJobs} job(s) still running`);
        return { defer: true, retryIn: 60_000 };
      }
    } catch {
      // Daemon unreachable, config files missing, or JSON parse error -> apply now.
    }
    return 'apply-now';
  },
}).catch(err => {
  process.stderr.write(`[orchestrator-updater] fatal: ${err}\n`);
  restoreConfigYml();
  process.exit(1);
}).finally(restoreConfigYml);
