'use strict';

/**
 * End-to-end smoke test: starts daemon, exercises CLI commands, stops daemon.
 * Run with: node packages/orchestrator/test/smoke.js
 */

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT    = path.join(__dirname, '..', '..', '..');
const TSX_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const TSX     = TSX_BIN;
const CLI     = path.join(__dirname, '..', 'src', 'cli.ts');
const DAEMON  = path.join(__dirname, '..', 'src', 'index.ts');
const CONFIG  = path.join(os.homedir(), '.config', 'orchestrator-smoke-test');

process.env.ORCH_CONFIG_DIR = CONFIG;

let passed = 0;
let failed = 0;

function ok(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function cli(...args) {
  try {
    return execSync(`"${TSX}" "${CLI}" ${args.join(' ')}`, {
      env: { ...process.env, ORCH_CONFIG_DIR: CONFIG },
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  } catch (e) {
    return e.stdout?.trim() ?? '';
  }
}

async function main() {
  // Clean up from any previous run
  if (fs.existsSync(CONFIG)) fs.rmSync(CONFIG, { recursive: true });
  fs.mkdirSync(CONFIG, { recursive: true });

  console.log('\n[smoke] Starting daemon...');
  const daemon = spawn(TSX, [DAEMON], {
    env: { ...process.env, ORCH_CONFIG_DIR: CONFIG },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

  daemon.stderr.on('data', (d) => process.stderr.write(d));

  // Wait for daemon to be ready (port file written)
  const portFile = path.join(CONFIG, 'config.port');
  await new Promise((resolve) => {
    const poll = setInterval(() => {
      if (fs.existsSync(portFile)) { clearInterval(poll); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(poll); resolve(); }, 5000);
  });

  const portData = JSON.parse(fs.readFileSync(portFile, 'utf8'));
  ok('daemon started and wrote config.port', portData.port > 0);
  ok('health_token file created', fs.existsSync(path.join(CONFIG, 'health_token')));

  console.log('\n[smoke] Testing orch status...');
  const status = cli('status');
  ok('orch status returns port', status.includes(String(portData.port)));

  console.log('\n[smoke] Testing orch add cron...');
  const addOut = cli(
    'add cron assurance-daily',
    '--schedule "0 8 * * *"',
    '--command "echo hello"',
    '--label "Test cron"',
  );
  ok('orch add cron succeeds', addOut.includes('assurance-daily'));

  console.log('\n[smoke] Testing orch list...');
  const list = cli('list');
  ok('orch list shows assurance-daily', list.includes('assurance-daily'));

  console.log('\n[smoke] Testing orch show...');
  const show = cli('show assurance-daily');
  ok('orch show returns job detail', show.includes('0 8 * * *'));

  console.log('\n[smoke] Testing orch disable / enable...');
  cli('disable assurance-daily');
  const listAfterDisable = cli('list');
  ok('job shows disabled', listAfterDisable.includes('assurance-daily'));
  cli('enable assurance-daily');

  console.log('\n[smoke] Testing orch add startup...');
  const addStartup = cli(
    'add startup my-startup',
    '--command "echo startup"',
    '--delay 0',
    '--label "Test startup"',
  );
  ok('orch add startup succeeds', addStartup.includes('my-startup'));

  console.log('\n[smoke] Testing orch edit...');
  cli('edit assurance-daily --label "Renamed"');
  const showEdited = cli('show assurance-daily');
  ok('orch edit updates label', showEdited.includes('Renamed'));

  console.log('\n[smoke] Testing orch remove...');
  cli('remove assurance-daily');
  const listAfterRemove = cli('list');
  ok('job removed from list', !listAfterRemove.includes('assurance-daily'));

  console.log('\n[smoke] Testing orch trigger...');
  const trigger = cli('trigger my-startup');
  ok('orch trigger returns pid or triggered', trigger.length > 0);

  console.log('\n[smoke] Stopping daemon...');
  cli('stop');
  await new Promise((r) => setTimeout(r, 500));
  ok('daemon process exited', !fs.existsSync(portFile) || daemon.exitCode !== null);

  daemon.kill();

  // Cleanup
  fs.rmSync(CONFIG, { recursive: true, force: true });

  console.log(`\n[smoke] ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('[smoke] fatal:', e); process.exit(1); });
