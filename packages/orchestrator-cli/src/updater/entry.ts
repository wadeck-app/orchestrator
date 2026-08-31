// orchestrator-updater entry point - bundled by CI as dist/orchestrator-updater.cjs.
// Spawned as a detached process by UpdateManager.scheduleBackgroundUpdate().
// Must NOT import any orchestrator runtime modules.
//
// Strategy: without-daemon + restartDaemon.
// npm install is done by Node.js (windowsHide:true) - zero terminal windows, proven by PoC.
// After successful install, writes config.restart sentinel then POST /quit so the
// Go launcher restarts the daemon with the new version.
import { runUpdater, execNpm } from '@wadeck-app/shared-updater';
import { ConfigDir } from '@wadeck-app/shared-cli/ConfigDir';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as http from 'node:http';

declare const __ORCH_VERSION__: string;

const PKG_NAME = '@wadeck-app/orchestrator-cli';
const configDir = process.env['ORCH_CONFIG_DIR'] ?? ConfigDir.get('orchestrator');
const currentVersion = typeof __ORCH_VERSION__ !== 'undefined' ? __ORCH_VERSION__ : '0.0.0-dev';

// Compute self-check command so shared-updater can verify the install after upgrade.
try {
  const npmRoot = execNpm(['root', '-g'], { timeout: 10_000 }).trim();
  const selfCheckCmd = `${process.execPath} ${join(npmRoot, PKG_NAME, 'dist', 'cli.js')} cli self-check`;
  process.env['UPDATER_SELF_CHECK_CMD'] = selfCheckCmd;
} catch {
  // Skip self-check if npm root is unavailable.
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
  onUpdateAvailable: async (_newVersion: string) => {
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
        // Critical jobs are running — defer the update to avoid disruption.
        return { defer: true, retryIn: 60_000 };
      }
    } catch {
      // Daemon unreachable, config files missing, or JSON parse error → apply now.
    }
    return 'apply-now';
  },
}).catch(err => {
  process.stderr.write(`[orchestrator-updater] fatal: ${err}\n`);
  process.exit(1);
});
