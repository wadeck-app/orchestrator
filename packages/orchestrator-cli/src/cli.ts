import fs   from 'node:fs';
import os   from 'node:os';
import path from 'node:path';
import type { CliDeps, LivenessConfig } from './types.js';
import { WindowsTask } from './windows/WindowsTask.js';
import { getErrorMessage } from './fsUtil.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logCliInvocation } = require('@wadeck-app/shared-cli/CliLogger') as typeof import('@wadeck-app/shared-cli/CliLogger');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseDuration } = require('@wadeck-app/shared-cli/Duration') as typeof import('@wadeck-app/shared-cli/Duration');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { cliVersionCommand, cliUpdateCommand, cliLogsCommand, warnUnknownArgs } = require('@wadeck-app/shared-cli/CliMetaCommands') as typeof import('@wadeck-app/shared-cli/CliMetaCommands');

const DEFAULT_CONFIG_DIR =
  process.env['ORCH_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'orchestrator');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// Arg parsing helpers
// ---------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(name);
}


function buildLiveness(argv: string[]): LivenessConfig | null {
  const strategy = flag(argv, '--liveness-strategy');
  if (!strategy || strategy === 'none') return null;
  const liveness: LivenessConfig = { strategy: strategy as LivenessConfig['strategy'] };
  if (strategy === 'portFile') liveness.portFile = flag(argv, '--liveness-port-file');
  if (strategy === 'command')  liveness.command  = flag(argv, '--liveness-command');
  return liveness;
}

// ---------------------------------------------------------------------------
// Output: context-aware (TTY → human, no-TTY or --json → JSON)
// ---------------------------------------------------------------------------

function output(data: unknown, forceJson: boolean): void {
  if (!forceJson && process.stdout.isTTY) {
    if (typeof data === 'string') { console.log(data); return; }
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(JSON.stringify(data));
  }
}

const HELP_TEXT = `
orch -- cross-platform job orchestrator

Usage: orch <command> [options]

Daemon lifecycle:
  orch start                   Start the daemon (idempotent)
  orch stop                    Stop the daemon
  orch restart                 Restart the daemon
  orch status                  Show daemon pid, port, uptime
  orch install                 Register orchestrator in OS startup
  orch uninstall               Remove from OS startup

Job inspection:
  orch list [--verbose]        List all jobs
  orch show <id>               Show full job detail
  orch --pid                   Show daemon pid/port (no daemon required)

Job mutation:
  orch add cron <id> --schedule <expr> --command <cmd> [--cwd <p>] [--label <t>]
                               [--trigger-mode fire-and-forget|wait]
                               [--missed-firing catch-up|skip]
                               [--liveness-strategy none|portFile|pidFile|command]
                               [--liveness-port-file <p>] [--liveness-command <c>]
                               [--disabled]
  orch add startup <id> --command <cmd> [--delay <seconds>] [--cwd <p>] [--label <t>]
  orch add --once <id> --delay <duration> --command <cmd> [--cwd <p>] [--label <t>]
                               Fire once after <duration> (e.g. 30s, 2m, 1h, 1d), then self-delete
  orch remove <id>             Remove a job
  orch enable <id>             Enable a job
  orch disable <id>            Disable a job
  orch edit <id> [--schedule <expr>] [--delay <s>] [--command <c>] [--label <t>] ...

Manual execution:
  orch trigger <id> [--wait]   Fire a job immediately

Dashboard:
  orch server start            Start the web dashboard server (opens browser)
  orch server stop             Stop the web dashboard server
  orch server status           Show dashboard server status and URL

Logs:
  orch logs [--follow]         Read today's orchestrator log file; --follow tails it

Global flags:
  --json                       Force JSON output
  --version                    Print version and exit
  --pid                        Print daemon pid/port and exit
  --help                       Show this help

Internal (used by auto-updater, not for general use):
  orch cli self-check          Validate bundle integrity; exit 0=ok, 1=fail

Exit codes: 0=ok  1=error  2=daemon-not-running  3=not-found  4=validation-error

Other commands:
  setup-task                Install a daily Windows Scheduled Task (twice daily)
  remove-task               Remove the scheduled task

Environment variables:
  ORCH_CONFIG_DIR         Config directory (default: ~/.config/orchestrator)
  ORCH_UPDATE_INTERVAL    Background update interval (default: 4h)
`.trim();

const CLI_GROUP_HELP = `
orch cli -- internal management commands

Usage: orch cli <subcommand>

Subcommands:
  self-check         Validate bundle integrity (exit 0=ok, 1=fail)
  logs [--follow]    Read today's orchestrator log file; --follow tails it
  update             Run a foreground update check

Environment variables:
  ORCH_CONFIG_DIR         Config directory (default: ~/.config/orchestrator)
  ORCH_UPDATE_INTERVAL    Background update check interval (e.g. 4h, 30m, 1d)
  CLI_SELF_CHECK_QUIET=1  Suppress self-check output
`.trim();

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runCli(argv: string[], deps: Partial<CliDeps> = {}): Promise<void> {
  const send        = deps.send        ?? (() => { throw new Error('no send'); });
  const startDaemon = deps.startDaemon ?? (() => {});
  const configDir   = deps.configDir   ?? DEFAULT_CONFIG_DIR;
  const forceJson   = has(argv, '--json');

  // Log every CLI invocation to configDir/logs/YYYY-MM-DD.ndjson
  const cleanCmd = argv.filter(a => a !== '--json');
  if (cleanCmd[0] !== 'logs' && cleanCmd[1] !== 'logs') {
    try { logCliInvocation(configDir, 'orch', argv); } catch { /* never block */ }
  }

  // --- Global flags that don't require a running daemon ---

  if (has(argv, '--version')) {
    console.log(version);
    return;
  }

  if (has(argv, '--help') || argv[0] === 'help') {
    console.log(HELP_TEXT);
    return;
  }

  if (has(argv, '--pid')) {
    const fs = require('node:fs') as typeof import('node:fs');
    const portFile = path.join(configDir, 'config.port');
    if (!fs.existsSync(portFile)) {
      console.log('not running');
      return;
    }
    try {
      const { pid, port } = JSON.parse(fs.readFileSync(portFile, 'utf8')) as { pid: number; port: number };
      try { process.kill(pid, 0); console.log(`pid=${pid}  port=${port}`); }
      catch { console.log('not running (stale port file)'); }
    } catch { console.log('not running'); }
    return;
  }

  // Strip global flags before command dispatch
  const cleanArgv = argv.filter(a => a !== '--json');
  const [cmd, ...rest] = cleanArgv;

  switch (cmd) {

    case 'status': {
      // 'version' is special: resolved via client.version() in the entry point send wrapper
      const data = await send('version') as { pid: number; port: number; uptime?: number };
      if (forceJson || !process.stdout.isTTY) {
        console.log(JSON.stringify(data));
      } else {
        console.log(`pid=${data.pid}  port=${data.port}  uptime=${data.uptime ?? '?'}s`);
      }
      break;
    }

    case 'start': startDaemon(); break;

    case 'stop': {
      const fs = require('node:fs') as typeof import('node:fs');
      if (!fs.existsSync(path.join(configDir, 'config.port'))) {
        console.log('Orchestrator is not running.');
        break;
      }
      await send('quit');
      console.log('Orchestrator stopped.');
      break;
    }

    case 'restart': {
      await send('restart');
      console.log('Orchestrator restarted.');
      break;
    }

    case 'install': {
      const { enableStartup } = await import('./startup.js');
      const result = enableStartup(configDir);
      if (result.ok) {
        console.log(`Orchestrator registered for startup. (${result.detail})`);
      } else {
        console.error(`Failed to register startup: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall': {
      const { disableStartup } = await import('./startup.js');
      const result = disableStartup(configDir);
      if (result.ok) {
        console.log(`Orchestrator removed from startup. (${result.detail})`);
      } else {
        console.error(`Failed to remove startup: ${result.error}`);
        process.exit(1);
      }
      break;
    }

    case 'list': {
      const verbose = has(rest, '--verbose');
      const [jobs, stateMap] = await Promise.all([
        send('list-jobs') as Promise<Array<Record<string, unknown>>>,
        verbose
          ? (send('list-state') as Promise<Record<string, Array<Record<string, unknown>>>>)
          : Promise.resolve({} as Record<string, Array<Record<string, unknown>>>),
      ]);
      if (!jobs?.length) {
        output(forceJson || !process.stdout.isTTY ? [] : 'No jobs registered.', forceJson);
        break;
      }
      if (forceJson || !process.stdout.isTTY) {
        output(jobs, forceJson);
        break;
      }
      for (const j of jobs) {
        let scheduleDisplay: string;
        if (j['type'] === 'once') {
          const remainingMs = (new Date(String(j['scheduledAt'])).getTime() + Number(j['delayMs'])) - Date.now();
          scheduleDisplay = `in ${Math.max(0, Math.round(remainingMs / 1000))}s`;
        } else {
          scheduleDisplay = j['schedule'] != null ? String(j['schedule']) : String(j['delaySeconds']) + 's';
        }
        // violations-suppress: shared/no-emoji CLI terminal indicator - intentional visual marker for enabled/disabled state
        const line  = `${j['enabled'] ? '✓' : '✗'} ${String(j['id']).padEnd(24)} ${String(j['type']).padEnd(8)} ${scheduleDisplay}`;
        let extra = '';
        if (verbose) {
          const history = stateMap[String(j['id'])];
          const lastRun = Array.isArray(history) && history.length > 0 ? history[0] : null;
          extra = `  last=${String(lastRun?.['startedAt'] ?? '-')}  exit=${String(lastRun?.['exitCode'] ?? '-')}`;
        }
        console.log(line + extra);
      }
      break;
    }

    case 'show': {
      const [id] = rest;
      const job = await send('get-job', { id });
      if (!job) { console.error(`Job not found: "${id}"`); process.exit(3); }
      output(job, forceJson);
      break;
    }

    case 'add': {
      let type: string;
      let id: string | undefined;
      let addRest: string[];

      if (has(rest, '--once')) {
        type = 'once';
        const flagsWithValues = new Set(['--delay', '--command', '--cwd', '--label', '--trigger-mode',
          '--liveness-strategy', '--liveness-port-file', '--liveness-command']);
        const positionals: string[] = [];
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--once' || rest[i] === '--disabled') continue;
          if (rest[i]!.startsWith('--')) {
            if (flagsWithValues.has(rest[i]!)) i++;
          } else {
            positionals.push(rest[i]!);
          }
        }
        id      = positionals[0];
        addRest = rest.filter(a => a !== '--once');
      } else {
        const [t, i, ...r] = rest;
        type    = t ?? '';
        id      = i;
        addRest = r;
      }

      if (!id) { console.error('Missing job id.'); process.exit(4); }
      const command = flag(addRest, '--command');
      if (!command) { console.error('--command is required.'); process.exit(4); }

      const body: Record<string, unknown> = {
        id, type, command, enabled: !has(addRest, '--disabled'),
      };

      const label       = flag(addRest, '--label');
      const cwd         = flag(addRest, '--cwd');
      const triggerMode = flag(addRest, '--trigger-mode');
      const liveness    = buildLiveness(addRest);

      if (label)       body['label']       = label;
      if (cwd)         body['cwd']         = cwd;
      if (triggerMode) body['triggerMode'] = triggerMode;
      if (liveness)    body['liveness']    = liveness;

      if (type === 'cron') {
        const schedule = flag(addRest, '--schedule');
        if (!schedule) { console.error('--schedule is required for cron jobs.'); process.exit(4); }
        body['schedule'] = schedule;
        const missedFiring = flag(addRest, '--missed-firing');
        if (missedFiring) body['missedFiring'] = missedFiring;
      }

      if (type === 'startup') {
        const delay = flag(addRest, '--delay');
        if (delay !== undefined) body['delaySeconds'] = parseInt(delay, 10);
      }

      if (type === 'once') {
        const delayStr = flag(addRest, '--delay');
        if (!delayStr) { console.error('--delay is required for once jobs.'); process.exit(4); }
        let delayMs: number;
        try {
          delayMs = parseDuration(delayStr);
        } catch (e) {
          console.error((e as Error).message);
          process.exit(4);
        }
        body['delayMs']     = delayMs;
        body['scheduledAt'] = new Date().toISOString();
      }

      await send('add-job', body);
      console.log(`Job "${id}" added.`);
      break;
    }

    case 'remove': {
      const [id] = rest;
      await send('remove-job', { id });
      console.log(`Job "${id}" removed.`);
      break;
    }

    case 'enable': {
      const [id] = rest;
      await send('enable-job', { id });
      console.log(`Job "${id}" enabled.`);
      break;
    }

    case 'disable': {
      const [id] = rest;
      await send('disable-job', { id });
      console.log(`Job "${id}" disabled.`);
      break;
    }

    case 'edit': {
      const [id, ...editRest] = rest;
      const updates: Record<string, unknown> = {};
      const fields = ['--schedule', '--command', '--cwd', '--label', '--trigger-mode', '--missed-firing',
                      '--liveness-port-file', '--liveness-command'];
      for (const f of fields) {
        const val = flag(editRest, f);
        if (val !== undefined) {
          const key = f.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          updates[key] = val;
        }
      }
      const delay = flag(editRest, '--delay');
      if (delay !== undefined) updates['delaySeconds'] = parseInt(delay, 10);
      const livenessStrategy = flag(editRest, '--liveness-strategy');
      if (livenessStrategy) updates['liveness'] = buildLiveness(editRest);

      await send('edit-job', { id, updates });
      console.log(`Job "${id}" updated.`);
      break;
    }

    case 'trigger':
    case 'run': {
      const [id, ...trigRest] = rest;
      const wait = has(trigRest, '--wait');
      const data = await send('trigger-job', { id, wait }) as { exitCode?: number; pid?: number };
      console.log(wait
        ? `Job "${id}" finished (exit ${data.exitCode ?? '?'}).`
        : `Job "${id}" triggered (pid ${data.pid ?? '?'}).`);
      break;
    }

    case 'cli': {
      const [subCmd, ...cliRest] = rest;

      if (subCmd === '--help' || subCmd === '-h' || subCmd === 'help') {
        console.log(CLI_GROUP_HELP);
        return;
      }

      if (subCmd === 'self-check') {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { runSelfCheck } = require('./self-check') as typeof import('./self-check.js');
        const quiet = has(rest, '--quiet') || process.env['CLI_SELF_CHECK_QUIET'] === '1';
        await runSelfCheck(quiet);
        return;
      }

      if (subCmd === 'version') {
        warnUnknownArgs(cliRest, [], 'orch cli version');
        await cliVersionCommand('@wadeck-app/orchestrator-cli', version);
        return;
      }

      if (subCmd === 'logs') {
        warnUnknownArgs(cliRest, ['--follow', '-f'], 'orch cli logs');
        await cliLogsCommand(configDir, { follow: has(cliRest, '--follow') || has(cliRest, '-f') });
        return;
      }

      if (subCmd === 'update') {
        const updaterPath = path.join(__dirname, 'orchestrator-updater.cjs');
        const fsCheck = require('node:fs') as typeof import('node:fs');
        if (!fsCheck.existsSync(updaterPath)) {
          process.stderr.write(`[fail] Updater not found: ${updaterPath} (dev mode -- no bundle)\n`);
          process.exit(1);
        }
        await cliUpdateCommand(updaterPath, '@wadeck-app/orchestrator-cli', { rawArgs: cliRest });
        return;
      }

      warnUnknownArgs([String(subCmd ?? '')], ['self-check', 'version', 'logs', 'update', '--help', '-h', 'help'], 'orch cli');
      console.error(`Unknown cli subcommand: "${String(subCmd)}". Run: orch cli --help`);
      process.exit(1);
      break;
    }

    case 'setup-task': {
      const nodePath    = process.execPath.replace(/\//g, '\\');
      const projectDir  = path.join(path.dirname(process.argv[1] ?? __filename), '..').replace(/\//g, '\\');
      const runnerJs    = path.join(projectDir, 'scripts', 'task-runner.js');
      const launcherVbs = path.join(configDir, 'orchestrator-launcher.vbs');
      const task = new WindowsTask({
        taskName:    'Orchestrator-Sync',
        projectDir,
        nodePath,
        runnerJs,
        launcherVbs,
        schedule1:   '08:00',
        schedule2:   '20:00',
        description: `Orchestrator scheduled task. Installed: ${new Date().toISOString().slice(0, 10)}.`,
      });
      try {
        task.install();
        console.log('[ok] Scheduled task installed.');
      } catch (e) {
        console.error(`[fail] Failed to install task: ${(e as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'remove-task': {
      const nodePath    = process.execPath.replace(/\//g, '\\');
      const projectDir  = path.join(path.dirname(process.argv[1] ?? __filename), '..').replace(/\//g, '\\');
      const runnerJs    = path.join(projectDir, 'scripts', 'task-runner.js');
      const launcherVbs = path.join(configDir, 'orchestrator-launcher.vbs');
      const task = new WindowsTask({
        taskName:    'Orchestrator-Sync',
        projectDir,
        nodePath,
        runnerJs,
        launcherVbs,
        schedule1:   '08:00',
        schedule2:   '20:00',
        description: '',
      });
      try {
        task.uninstall();
        console.log('[ok] Scheduled task removed.');
      } catch (e) {
        console.error(`[fail] Failed to remove task: ${(e as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'server': {
      const sub = rest[0];
      const dashPortFile = path.join(configDir, 'config.dashboard');
      if (sub === 'start') {
        let serverBinary: string;
        try {
          const { findOrchServerBinary } = require('./dashboard-binary.js') as typeof import('./dashboard-binary.js');
          serverBinary = findOrchServerBinary();
        } catch (e) {
          console.error(`Dashboard server not available: ${(e as Error).message}`);
          process.exit(1);
        }
        // Check if already running
        if (fs.existsSync(dashPortFile)) {
          try {
            const info = JSON.parse(fs.readFileSync(dashPortFile, 'utf8')) as { port: number; pid: number };
            console.log(`Dashboard already running at http://localhost:${info.port}`);
            process.exit(0);
          } catch { /* stale file, continue */ }
        }
        // Auto-start daemon if not running
        const daemonPortFile = path.join(configDir, 'config.port');
        const isDaemonRunning = (): boolean => {
          try {
            if (!fs.existsSync(daemonPortFile)) return false;
            const stat = fs.statSync(daemonPortFile);
            return (Date.now() - stat.mtimeMs) < 60_000;
          } catch { return false; }
        };
        if (!isDaemonRunning()) {
          console.log('Orchestrator daemon is not running -- starting it...');
          startDaemon();
          // Wait up to 10s for daemon port file to appear
          const deadline = Date.now() + 10_000;
          await new Promise<void>((resolve, reject) => {
            const tick = (): void => {
              if (isDaemonRunning()) { resolve(); return; }
              if (Date.now() >= deadline) { reject(new Error('Daemon did not start within 10s')); return; }
              setTimeout(tick, 200);
            };
            tick();
          });
          console.log('Orchestrator daemon started.');
        }
        const { spawn } = require('node:child_process') as typeof import('node:child_process');
        const { createInterface } = require('node:readline') as typeof import('node:readline');
        const child = spawn(process.execPath, [serverBinary, '--config-dir', configDir, '--base-port', '47950'], {
          stdio: ['ignore', 'pipe', 'inherit'],
          detached: true,
          windowsHide: true,
        });
        const rl = createInterface({ input: child.stdout! });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Dashboard server did not start within 10s')), 10000);
          rl.on('line', (line: string) => {
            try {
              const msg = JSON.parse(line) as { type: string; port?: number };
              if (msg.type === 'ready') {
                clearTimeout(timer);
                console.log(`Dashboard started at http://localhost:${msg.port}`);
                resolve();
              }
            } catch { /* non-JSON line, ignore */ }
          });
          child.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
        });
        child.unref();
        process.exit(0);
      } else if (sub === 'stop') {
        if (!fs.existsSync(dashPortFile)) {
          console.log('Dashboard server is not running.');
          process.exit(0);
        }
        const info = JSON.parse(fs.readFileSync(dashPortFile, 'utf8')) as { pid: number };
        try {
          process.kill(info.pid, 'SIGTERM');
          fs.unlinkSync(dashPortFile);
          console.log('Dashboard server stopped.');
        } catch (e) {
          console.error(`Failed to stop dashboard server: ${(e as Error).message}`);
          process.exit(1);
        }
        process.exit(0);
      } else if (sub === 'status') {
        if (!fs.existsSync(dashPortFile)) {
          console.log('Dashboard server: stopped');
          process.exit(0);
        }
        const info = JSON.parse(fs.readFileSync(dashPortFile, 'utf8')) as { port: number; pid: number; startedAt: string };
        const url = `http://localhost:${info.port}`;
        let alive = false;
        try {
          const res = await fetch(`${url}/api/heartbeat`, { method: 'POST', signal: AbortSignal.timeout(2000) });
          alive = res.status === 204;
        } catch { /* not reachable */ }
        if (alive) {
          console.log(`Dashboard server: running  pid=${info.pid}  url=${url}  started=${info.startedAt}`);
        } else {
          console.log(`Dashboard server: stale (pid=${info.pid} not responding -- run "orch server stop" to clean up)`);
        }
        process.exit(0);
      } else {
        console.error('Usage: orch server start|stop|status');
        process.exit(1);
      }
    }

    // Top-level alias for `orch cli logs`
    case 'logs': {
      warnUnknownArgs(rest, ['--follow', '-f'], 'orch logs');
      await cliLogsCommand(configDir, { follow: has(rest, '--follow') || has(rest, '-f') });
      return;
    }

    default: {
      console.error(`Unknown command: "${String(cmd)}". Run: orch --help`);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point (when invoked as a binary)
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const fs = require('node:fs') as typeof import('node:fs');
  const { createDaemonClient } = require('@wadeck-app/singleton-daemon-kit') as typeof import('@wadeck-app/singleton-daemon-kit');
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  const { makeCommands } = require('./commands.js') as typeof import('./commands.js');
  const { Registry } = require('./registry.js') as typeof import('./registry.js');
  const { State }    = require('./state.js')    as typeof import('./state.js');

  const configDir = DEFAULT_CONFIG_DIR;

  // Dummy command stubs - only used for type inference by the SDK client (not executed)
  const dummyRegistry = new Registry(path.join(configDir, 'registry.json'));
  const dummyState    = new State(path.join(configDir, 'state.json'));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // violations-suppress: ts/no-unsafe-type-cast dummy Scheduler cast for type inference only - never executed
  const commands = makeCommands(dummyRegistry, dummyState, null as any, configDir);

  const client = createDaemonClient({ configDir, commands });

  function startDaemon(): void {
    const daemonPath = path.join(__dirname, 'index.js');
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ORCH_CONFIG_DIR: configDir },
    });
    child.unref();
    console.log('Orchestrator starting...');
  }

  // Wait up to timeoutMs for the daemon port file to appear (async-friendly polling).
  function waitForDaemon(timeoutMs: number): Promise<boolean> {
    const portFile = path.join(configDir, 'config.port');
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const tick = (): void => {
        if (fs.existsSync(portFile)) { resolve(true); return; }
        if (Date.now() >= deadline)  { resolve(false); return; }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // ssh-agent pattern (D25): auto-start daemon on first command that needs it,
  // wait up to 3 s, retry once. --version / --pid bypass this via early returns in runCli.
  let _autoStarted = false;
  function send(command: string, payload?: unknown): Promise<unknown> {
    const doSend = (): Promise<unknown> => {
      if (command === 'version') return client.version() as Promise<unknown>;
      const c = client as { send(cmd: string, p?: unknown): Promise<unknown> };
      return c.send(command, payload);
    };

    return doSend().catch(async (e: unknown) => {
      const msg = getErrorMessage(e);
      const isDaemonDown = msg.includes('not running') || msg.includes('ECONNREFUSED') || msg.includes('ENOENT');
      if (isDaemonDown && !_autoStarted) {
        _autoStarted = true;
        startDaemon();
        const ready = await waitForDaemon(3000);
        if (!ready) {
          console.error('Orchestrator could not be started. Run: orch start');
          process.exit(2);
        }
        // Retry once after auto-start
        return doSend().catch((e2: unknown) => {
          console.error(`Error: ${getErrorMessage(e2)}`);
          process.exit(1);
        });
      }
      if (msg.includes('not found') || msg.includes('Not found')) {
        console.error(`Error: ${msg}`);
        process.exit(3);
      }
      console.error(`Error: ${msg}`);
      process.exit(1);
    });
  }

  // Read and display any pending update notice from the background updater.
  const { UpdateManager: CliUpdateManager } = await import('@wadeck-app/shared-cli');
  const cliUpdateManager = new CliUpdateManager('@wadeck-app/orchestrator-cli', configDir);
  const cliUpdateState = cliUpdateManager.readAndClearState();
  if (cliUpdateState?.status === 'success') process.stderr.write(`[orch] Updated to v${cliUpdateState.targetVersion ?? cliUpdateState.newVersion}\n`);
  if (cliUpdateState?.status === 'rolled-back') process.stderr.write(`[orch] Rollback to v${cliUpdateState.previousVersion}\n`);
  if (cliUpdateState?.status === 'failed') process.stderr.write(`[orch] Update failed (${cliUpdateState.error ?? cliUpdateState.reason})\n`);

  await runCli(process.argv.slice(2), { send, startDaemon, configDir });
}

if (require.main === module) {
  main().catch((e: unknown) => { console.error(getErrorMessage(e)); process.exit(1); });
}
