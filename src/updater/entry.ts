// orchestrator-updater entry point - bundled by CI as dist/orchestrator-updater.cjs.
// Spawned as a detached process by UpdateManager.scheduleBackgroundUpdate().
// Must NOT import any orchestrator runtime modules.
//
// Strategy: with-daemon (orchestrator-specific variant).
// Unlike queue/flow/task, orchestrator uses the Go launcher T8 sentinel pattern:
//   1. Writes config.update sentinel - Go launcher runs updateCmd after node exits.
//   2. Sends POST /quit to health server - daemon shuts down cleanly.
// shared-updater primitives handle lock, cache, version fetch, and state writing.
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  tryAcquireLock, releaseLock,
  readCache, writeCache, writeState,
  stateFilePath, cacheFilePath, lockFilePath,
  readUpdateConfig,
  fetchLatestVersion,
  appendLog,
  semverLte,
} from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';

// Injected by esbuild at bundle time; undefined in dev mode.
declare const __ORCH_VERSION__: string;

const PKG_NAME = '@wadeck-app/orchestrator-cli';

function getConfigDir(): string {
  if (process.env['ORCH_CONFIG_DIR']) return process.env['ORCH_CONFIG_DIR'];
  return ConfigDir.get('orchestrator');
}

async function main(): Promise<void> {
  const configDir = getConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const lockFile = lockFilePath(configDir);
  if (!tryAcquireLock(lockFile)) {
    appendLog(configDir, 'info', 'updater already running, skipping');
    return;
  }

  try {
    const force = process.env['UPDATER_FORCE'] === '1';
    const updateCfg = readUpdateConfig(configDir);
    if (updateCfg.disabled) return;

    const cache = readCache(cacheFilePath(configDir));
    const now = Date.now();
    if (!force && cache && now - cache.lastCheckedAt < updateCfg.checkIntervalMs) return;

    writeCache(cacheFilePath(configDir), { lastCheckedAt: now, latestVersion: null });

    let latestVersion: string;
    try {
      latestVersion = fetchLatestVersion(PKG_NAME, updateCfg.channel);
    } catch (err) {
      appendLog(configDir, 'warn', `version fetch failed: ${err}`);
      return;
    }

    writeCache(cacheFilePath(configDir), { lastCheckedAt: now, latestVersion });

    let currentVersion: string;
    try { currentVersion = __ORCH_VERSION__; }
    catch { return; } // dev mode - skip

    if (semverLte(latestVersion, currentVersion)) {
      if (force) process.stdout.write(`[orch] Already up to date (v${currentVersion})\n`);
      appendLog(configDir, 'info', `up to date (${currentVersion})`);
      return;
    }

    appendLog(configDir, 'info', `update available: ${currentVersion} -> ${latestVersion}`);

    // Step 1: Write config.update sentinel - Go launcher T8 reads this and runs updateCmd.
    fs.writeFileSync(path.join(configDir, 'config.update'), '1', 'utf-8');

    // Step 2: Send POST /quit so daemon shuts down cleanly (kills tray before exit).
    const portFilePath = path.join(configDir, 'config.port');
    if (fs.existsSync(portFilePath)) {
      try {
        const portData = JSON.parse(fs.readFileSync(portFilePath, 'utf-8')) as { port: number };
        const tokenPath = path.join(configDir, 'health_token');
        const healthToken = fs.readFileSync(tokenPath, 'utf-8').trim();
        await new Promise<void>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: portData.port,
            path: '/quit',
            method: 'POST',
            timeout: 5000,
            headers: { Authorization: `Bearer ${healthToken}`, 'Content-Length': 0 },
          }, () => resolve());
          req.on('error', () => resolve());
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.end();
        });
        appendLog(configDir, 'info', `POST /quit sent on port ${portData.port}`);
      } catch (err) {
        appendLog(configDir, 'warn', `POST /quit failed: ${err}`);
      }
    }

    // Step 3: Write update state so new version displays "Updated to X.Y.Z" at startup.
    // Write update-available (not success) — Go launcher applies the update after daemon exits.
    // The daemon will read this on next start and show "[orch] Updated to vX" if install succeeded.
    writeState(stateFilePath(configDir), {
      status: 'update-available',
      currentVersion,
      targetVersion: latestVersion,
      previousVersion: currentVersion,
      timestamp: Date.now(),
    });

    appendLog(configDir, 'info', `sentinel written - Go launcher will install ${currentVersion} -> ${latestVersion}`);

  } finally {
    releaseLock(lockFile);
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('entry.js') ||
   process.argv[1].endsWith('entry.ts') ||
   process.argv[1].endsWith('orchestrator-updater.cjs'));

if (isEntry) {
  main().catch(() => process.exit(1));
}
