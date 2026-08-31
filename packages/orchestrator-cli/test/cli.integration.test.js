'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const CLI_TS = path.join(ROOT, 'src', 'cli.ts');

// Walk up from __dirname to find the tsx bin (handles npm workspace hoisting)
function findBin(name) {
  const fs = require('node:fs');
  const binName = process.platform === 'win32' ? name + '.cmd' : name;
  let dir = __dirname;
  while (true) {
    const candidate = path.join(dir, 'node_modules', '.bin', binName);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`${name} not found in any node_modules/.bin`);
    dir = parent;
  }
}
const TSX_BIN = findBin('tsx');

/**
 * Spawn the orchestrator CLI via tsx (dev mode, no bundle).
 * Returns { code, stdout, stderr }.
 */
function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(TSX_BIN, [CLI_TS, ...args], {
      env: { ...process.env, ORCH_CONFIG_DIR: path.join(os.tmpdir(), 'orch-inttest'), ...env },
      // Required on Windows: .cmd scripts cannot be spawned without shell:true
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Bug A: self-check must write only to stderr
// ---------------------------------------------------------------------------

describe('orch cli self-check integration', () => {

  test('self-check writes to stderr only (no stdout output)', async () => {
    const { code, stdout, stderr } = await runCli(['cli', 'self-check'], {
      CLI_SELF_CHECK_QUIET: '0',
    });
    assert.equal(stdout, '', `Expected empty stdout, got: ${JSON.stringify(stdout)}`);
    assert.ok(stderr.length > 0, 'Expected self-check output on stderr');
    // exit 0 (pass) or 1 (fail) both acceptable
    assert.ok(code === 0 || code === 1, `Unexpected exit code: ${code}`);
  });

  test('self-check lines use [ok]/[fail] markers (no emoji)', async () => {
    const { stderr } = await runCli(['cli', 'self-check'], { CLI_SELF_CHECK_QUIET: '0' });
    // Verify [ok] or [fail] markers are present
    assert.ok(
      stderr.includes('[ok]') || stderr.includes('[fail]'),
      `Expected [ok] or [fail] in stderr, got: ${JSON.stringify(stderr)}`,
    );
    // Verify emoji are NOT present
    assert.ok(!stderr.includes('✓'), 'Unexpected ✓ emoji in output; use [ok] instead');
    assert.ok(!stderr.includes('✗'), 'Unexpected ✗ emoji in output; use [fail] instead');
  });

  test('CLI_SELF_CHECK_QUIET=1 suppresses all output', async () => {
    const { stdout, stderr } = await runCli(['cli', 'self-check'], {
      CLI_SELF_CHECK_QUIET: '1',
    });
    // Summary line "self-check: N passed" is still emitted even in quiet mode
    // But individual check lines must be suppressed
    const checkLines = stderr.split('\n').filter(l => l.startsWith('  [ok]') || l.startsWith('  [fail]'));
    assert.equal(checkLines.length, 0, `Quiet mode must suppress individual check lines, got: ${stderr}`);
    assert.equal(stdout, '', `Expected empty stdout in quiet mode, got: ${JSON.stringify(stdout)}`);
  });

});

// ---------------------------------------------------------------------------
// Bug B: cli update must produce visible output
// ---------------------------------------------------------------------------

describe('orch cli update integration', () => {

  test('cli update in dev mode prints [fail] and exits 1 (no bundle)', async () => {
    const { code, stderr } = await runCli(['cli', 'update']);
    // In dev mode (no orchestrator-updater.cjs bundle present), must fail visibly
    assert.equal(code, 1, `Expected exit 1 when updater bundle absent, got ${code}`);
    assert.ok(
      stderr.includes('[fail]') || stderr.includes('[orch]'),
      `Expected diagnostic output on stderr, got: ${JSON.stringify(stderr)}`,
    );
  });

});

// ---------------------------------------------------------------------------
// Bug C: unknown command must exit 1 (confirmed not a bug, regression guard)
// ---------------------------------------------------------------------------

describe('orch unknown command integration', () => {

  test('unknown top-level command exits 1', async () => {
    const { code } = await runCli(['completely-unknown-xyz']);
    assert.equal(code, 1, `Expected exit 1 for unknown command, got ${code}`);
  });

  test('unknown cli subcommand exits 1', async () => {
    const { code } = await runCli(['cli', 'unknown-subcommand']);
    assert.equal(code, 1, `Expected exit 1 for unknown cli subcommand, got ${code}`);
  });

});
