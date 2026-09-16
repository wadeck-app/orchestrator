#!/usr/bin/env node
/**
 * dev-server.mjs - run the dashboard from this checkout, isolated from the real install.
 *
 *   node scripts/dev-server.mjs [--seed] [--stop] [--prod-config]
 *
 * Two things are kept separate from the machine's real orchestrator:
 *
 *  - Code: the local `packages/orchestrator-cli/dist/orchestrator-cli.cjs` is
 *    invoked directly. dashboard-binary.ts resolves the server relative to its
 *    own __dirname, so this runs the checkout's server/dist and server/public.
 *    The globally installed package is never read or written.
 *  - State: ORCH_CONFIG_DIR points at <repo>/.dev-config, so the dev daemon
 *    writes its own state.json, audit log, port files and job logs. The real
 *    ~/.config/orchestrator is left alone.
 *
 * A dev config dir starts empty, so the dashboard shows no jobs. `--seed` copies
 * the job registry and config out of the real config dir once, read-only, to get
 * something to look at. `--prod-config` opts out of isolation entirely and points
 * the dev build at the real config dir - that lets a dev build write to real
 * state, so it must be asked for explicitly.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const args = process.argv.slice(2);
const SEED = args.includes('--seed');
const STOP = args.includes('--stop');
const USE_PROD_CONFIG = args.includes('--prod-config');

const CLI = resolve(ROOT, 'packages/orchestrator-cli/dist/orchestrator-cli.cjs');
const PROD_CONFIG_DIR = process.env.ORCH_CONFIG_DIR ?? join(homedir(), '.config', 'orchestrator');
const DEV_CONFIG_DIR = resolve(ROOT, '.dev-config');
const configDir = USE_PROD_CONFIG ? PROD_CONFIG_DIR : DEV_CONFIG_DIR;

if (!existsSync(CLI)) {
  console.error(`CLI not built at ${CLI}`);
  console.error('Run: node scripts/deploy-dev.mjs');
  process.exit(1);
}

if (USE_PROD_CONFIG) {
  console.log(`! Using the REAL config dir: ${configDir}`);
  console.log('  This dev build can write to real state, logs and audit history.');
} else {
  mkdirSync(configDir, { recursive: true });
  console.log(`Dev config dir: ${configDir}`);
}

// Seeded rather than symlinked: the dev daemon must not write back into the real
// config dir. Existing files are never overwritten, so local edits survive.
if (SEED && !USE_PROD_CONFIG) {
  for (const name of ['registry.json', 'config.yml']) {
    const src = join(PROD_CONFIG_DIR, name);
    const dst = join(configDir, name);
    if (!existsSync(src)) {
      console.log(`  seed: ${name} not present in ${PROD_CONFIG_DIR}, skipped`);
      continue;
    }
    if (existsSync(dst)) {
      console.log(`  seed: ${name} already exists, kept`);
      continue;
    }
    copyFileSync(src, dst);
    console.log(`  seed: copied ${name}`);
  }
}

const env = { ...process.env, ORCH_CONFIG_DIR: configDir };

function cli(subcommand) {
  return execFileSync(process.execPath, [CLI, ...subcommand], {
    env,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

// `server start` auto-starts a daemon when none is running, so an isolated run
// leaves a dev daemon (and its tray) behind too. Stopping only the server would
// strand them holding the dev port files.
if (STOP) {
  for (const sub of [['server', 'stop'], ['stop']]) {
    try {
      console.log(cli(sub));
    } catch (err) {
      console.log(`${sub.join(' ')}: ${err.stdout?.trim() || err.message}`);
    }
  }
  process.exit(0);
}

// Stop first so a rebuilt bundle is actually picked up: the running server keeps
// serving the assets it started with.
try {
  console.log(cli(['server', 'stop']));
} catch {
  // Nothing running, or the state file was already clean.
}

// Inherit stdio so the daemon's own startup output stays visible.
const child = spawn(process.execPath, [CLI, 'server', 'start'], {
  env,
  stdio: 'inherit',
  windowsHide: true,
});
child.on('exit', (code) => {
  if (code !== 0) {
    console.error(`\nserver start exited with code ${code}`);
    process.exit(code ?? 1);
  }
  console.log('\nStop it with: node scripts/dev-server.mjs --stop');
});
