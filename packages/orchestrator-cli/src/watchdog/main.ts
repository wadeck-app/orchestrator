/**
 * Entry point of dist/orchestrator-watchdog.cjs: `node orchestrator-watchdog.cjs [configDir]` (EXPERIMENTAL, opt-in).
 *
 * A pure-Node replacement of the Go launcher with the same contract: it runs `node dist/orchestrator.cjs <configDir>`, starts it
 * again after `config.restart`, restarts it after a crash with a back-off (2s, 10s, 30s, at most 3 in 10 minutes) and
 * leaves when the daemon stops for good. See docs/watchdog.md. The loop is in watchdog.ts; this file only wires the real effects.
 */
import os from 'node:os';
import path from 'node:path';

import { policyFromEnv } from './policy.js';
import {
  configDirFromArgs, createLogger, createPidFile, daemonEnv, daemonStdio, defaultConfigDir, isFile, realFs, resolveDaemonBundle,
  spawnDaemon, StopController,
} from './runtime.js';
import { superviseDaemon } from './watchdog.js';

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const given = configDirFromArgs(args);
  const configDir = given ?? defaultConfigDir(process.env, os.homedir());
  const log = createLogger(configDir);
  if (given === null) {
    log.info(`no config dir given: using ${configDir}`);
  }

  let policy;
  try {
    policy = policyFromEnv(process.env);
  } catch (e) {
    log.error(errText(e));
    return 1;
  }

  const stop = new StopController(process.platform, log);
  // SIGBREAK is Ctrl+Break and a closing console on Windows. A listener also keeps Node from dying silently on them.
  const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
  for (const signal of signals) {
    process.on(signal, () => {
      log.info(`${signal} received`);
      stop.onSignal(signal);
    });
  }

  const stdio = daemonStdio();
  const env = daemonEnv(process.env, { configDir, platform: process.platform, watchdogPid: process.pid });
  const nodePath = process.execPath;
  const code = await superviseDaemon(
    { configDir, policy, startCommand: 'orch start' },
    {
      fs: realFs,
      log,
      now: () => Date.now(),
      sleep: (ms) => stop.sleep(ms),
      // __dirname is dist/ in the bundle: the daemon bundle is its sibling, looked up again at every start.
      resolveBundle: () => resolveDaemonBundle({ env: process.env, dir: __dirname, isFile }),
      startDaemon: (bundle) => spawnDaemon({ nodePath, bundle, args, env, stdio, stop, log }),
      pidFile: createPidFile(configDir, process.pid),
      nodePath,
      pid: process.pid,
    },
  );
  return code;
}

main().then(
  // A negative code (a daemon killed by a signal) is not a valid exit status.
  (code) => { process.exit(code < 0 ? 1 : code); },
  (e: unknown) => {
    process.stderr.write(`[orchestrator-watchdog] fatal: ${errText(e)}. See ${path.join('<configDir>', 'logs')}, then run: orch start\n`);
    process.exit(1);
  },
);
