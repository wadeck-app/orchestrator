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

runUpdater({
  pkgName: PKG_NAME,
  configDir,
  currentVersion,
  strategy: 'without-daemon',
  restartDaemon: {
    portFile: join(configDir, 'config.port'),
    healthTokenFile: join(configDir, 'health_token'),
  },
}).catch(err => {
  process.stderr.write(`[orchestrator-updater] fatal: ${err}\n`);
  process.exit(1);
});
