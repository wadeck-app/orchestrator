'use strict';

// A stand-in for dist/orchestrator.cjs, used by watchdog-e2e.test.js. It is bundled by esbuild into <tmp>/dist/orchestrator.cjs
// and run with plain `node` by the real watchdog bundle, so it must not depend on tsx or on anything outside the bundle.
//
// FAKE_DAEMON_PLAN is a comma list, one step per start (the nth start runs the nth step; past the end it exits 0):
//   exit:N          exit with code N
//   restart         write config.restart, exit 0
//   crash-marker:N  write its own crashed.json (with a cause), exit N
//   wait            stay up until <configDir>/release exists, then exit 0; SIGTERM writes got-sigterm and exits 143
//   watch           stay up with the real pid watch (src/watchdog/pid-watch.ts, 100 ms poll); when the watchdog is gone write
//                   watch-gone and exit 0
// Every start appends a JSON line to <configDir>/starts.log.
const fs = require('node:fs');
const path = require('node:path');

const { startWatchdogWatch, stopWhenWatchdogGone } = require('../../src/watchdog/pid-watch');

const configDir = process.env.ORCH_CONFIG_DIR;
if (!configDir) {
  throw new Error('fake daemon: ORCH_CONFIG_DIR is not set');
}
const plan = (process.env.FAKE_DAEMON_PLAN ?? '').split(',').filter((s) => s !== '');
const countFile = path.join(configDir, 'fake-count');
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
fs.appendFileSync(path.join(configDir, 'starts.log'), `${JSON.stringify({
  n, pid: process.pid, argv: process.argv.slice(2), configDirEnv: process.env.ORCH_CONFIG_DIR, watchdogPid: process.env.ORCH_WATCHDOG_PID ?? null,
})}\n`);

const step = plan[n] ?? 'exit:0';
const [verb, arg] = step.split(':');
switch (verb) {
  case 'exit':
    process.exit(Number(arg));
    break;
  case 'restart':
    fs.writeFileSync(path.join(configDir, 'config.restart'), '1');
    process.exit(0);
    break;
  case 'crash-marker':
    fs.writeFileSync(path.join(configDir, 'crashed.json'), '{"time":"2026-10-25T00:00:30Z","kind":"uncaughtException","error":"the real cause","version":"1","pid":1}');
    process.exit(Number(arg));
    break;
  case 'wait':
    process.on('SIGTERM', () => {
      fs.writeFileSync(path.join(configDir, 'got-sigterm'), '1');
      process.exit(143);
    });
    setInterval(() => {
      if (fs.existsSync(path.join(configDir, 'release'))) {
        process.exit(0);
      }
    }, 20);
    break;
  case 'watch': {
    const keepAlive = setInterval(() => {}, 1000);
    startWatchdogWatch({
      env: process.env,
      log: (line) => fs.appendFileSync(path.join(configDir, 'watch.log'), `${line}\n`),
      intervalMs: 100,
      onGone: stopWhenWatchdogGone({
        stop: async () => {
          fs.writeFileSync(path.join(configDir, 'watch-gone'), '1');
          clearInterval(keepAlive);
        },
        exit: (code) => process.exit(code),
        log: (line) => fs.appendFileSync(path.join(configDir, 'watch.log'), `${line}\n`),
      }),
    });
    break;
  }
  default:
    throw new Error(`fake daemon: unknown step "${step}"`);
}
