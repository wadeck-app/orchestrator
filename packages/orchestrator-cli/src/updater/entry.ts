// orchestrator-updater entry point - bundled by CI as dist/orchestrator-updater.cjs.
// Spawned as a detached process by UpdateManager.scheduleBackgroundUpdate().
// Must NOT import any orchestrator runtime modules.
//
// Strategy: without-daemon + restartDaemon.
// npm install is done by Node.js (windowsHide:true) - zero terminal windows, proven by PoC.
// After successful install, writes config.restart sentinel then POST /quit so the
// Go launcher restarts the daemon with the new version.
import { runUpdater, execNpm, appendLog } from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolveSelfCheckTarget } from './self-check-target.js';
import { getErrorMessage } from '../fsUtil.js';
import * as http from 'node:http';
import semver from 'semver';

declare const __ORCH_VERSION__: string;

const PKG_NAME = '@wadeck-app/orchestrator-cli';
const configDir = process.env['ORCH_CONFIG_DIR'] ?? ConfigDir.get('orchestrator');
const currentVersion = typeof __ORCH_VERSION__ !== 'undefined' ? __ORCH_VERSION__ : '0.0.0-dev';

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
if (!process.env['UPDATER_SELF_CHECK_CMD']) {
  let npmRoot: string;
  try {
    npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
  } catch (e) {
    // shared-updater treats a missing UPDATER_SELF_CHECK_CMD as "self-check passed", so
    // carrying on here would install an unverified upgrade with no rollback. Fail closed,
    // and record it where `orch logs` can show it: this process is detached with stdio
    // ignored, so writing to the console would go nowhere.
    appendLog(configDir, 'error',
      `${PKG_NAME} update aborted: cannot resolve 'npm root -g', so the post-install `
      + `self-check could not be armed and an unverified update would not be rollback-able. `
      + `Cause: ${getErrorMessage(e)}`);
    // Restore config.yml before leaving. Under UPDATER_FORCE the autoUpdate:false line was
    // commented out above, and it is otherwise only restored once runUpdater completes. Exiting
    // here would leave the user's explicit "do not auto-update" disabled for good, so failing
    // closed on one axis would have silently opened another.
    restoreConfigYml();
    process.exit(1);
  }
  const resolved = resolveSelfCheckTarget(npmRoot, PKG_NAME);
  if (!resolved.ok) {
    // Arming a command whose target is absent is what caused the permanent rollback loop
    // described on resolveSelfCheckTarget. Refusing to update is recoverable; looping is not.
    appendLog(configDir, 'error',
      `${PKG_NAME} update aborted: ${resolved.reason}. Without a usable entry point the `
      + `post-install self-check cannot be armed, and an unverified update would not be `
      + `rollback-able. Repair with: npm install -g ${PKG_NAME}@latest`);
    restoreConfigYml();
    process.exit(1);
  }
  // execSync runs this through a shell, so both paths must be quoted. A default Windows
  // violations-suppress: shared/no-out-of-repo-path prose naming the case this guards, not a path the code uses
  // install puts node under "C:\Program Files\nodejs\", and an unquoted path is split at the
  // space: the self-check then always fails and every update gets rolled back.
  process.env['UPDATER_SELF_CHECK_CMD'] = `"${process.execPath}" "${resolved.target}" cli self-check`;
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
