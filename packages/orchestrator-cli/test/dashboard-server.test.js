'use strict';

/**
 * Integration tests for orch-server.
 *
 * Key invariant: GET /api/jobs must NEVER return 500.
 * - If daemon is reachable and healthy: 200 + array
 * - If daemon is unreachable (ECONNREFUSED, stale port, etc.): 503 daemon-not-running
 * - 500 means an unhandled internal error -- always a bug.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const { createInterface } = require('node:readline');

const SERVER_BIN = path.join(__dirname, '..', 'server', 'dist', 'index.js');

function startServer(configDir, basePort) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      SERVER_BIN, '--config-dir', configDir, '--base-port', String(basePort),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const rl = createInterface({ input: child.stdout });
    const errors = [];

    createInterface({ input: child.stderr }).on('line', (line) => {
      if (!line.includes('MODULE_TYPELESS_PACKAGE_JSON') && !line.includes('Reparsing')
          && !line.includes('add "type"') && !line.includes('trace-warnings')) {
        errors.push(line);
      }
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start within 5s. stderr: ${errors.join('\n')}`));
    }, 5000);

    rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'ready') { clearTimeout(timer); resolve({ child, port: msg.port }); }
      } catch { /* ignore */ }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}. stderr: ${errors.join('\n')}`));
      }
    });
  });
}

// Create a minimal config dir with a fake config.port pointing to a dead port.
// This simulates: daemon was running, wrote port file, but is now unreachable.
function makeDeadDaemonConfigDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dead-daemon-'));
  fs.writeFileSync(path.join(dir, 'health_token'), 'test-token-abc123');
  fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({
    sdkVersion: 1,
    port: 19998,  // nothing listening here
    pid: 99999,
    startedAt: new Date().toISOString(),
  }));
  return dir;
}

describe('orch-server integration', () => {
  test('server binary exists', () => {
    assert.ok(fs.existsSync(SERVER_BIN), `server binary not found at ${SERVER_BIN}`);
  });

  test('server starts, heartbeat returns 204, SPA returns 200', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-test-'));
    const { child, port } = await startServer(configDir, 48100);
    try {
      const hb = await fetch(`http://localhost:${port}/api/heartbeat`, { method: 'POST', signal: AbortSignal.timeout(2000) });
      assert.equal(hb.status, 204, 'heartbeat must return 204');

      const spa = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
      assert.equal(spa.status, 200, 'SPA must return 200');
    } finally {
      child.kill();
    }
  });

  // BUG REGRESSION TEST: GET /api/jobs must return 503 (not 500)
  // when the daemon port file exists but daemon is unreachable (ECONNREFUSED).
  // Before the fix, fetch() threw TypeError which was not caught as DaemonUnavailableError -> 500.
  test('GET /api/jobs returns 503 (not 500) when daemon port exists but connection is refused', async () => {
    const configDir = makeDeadDaemonConfigDir();
    const { child, port } = await startServer(configDir, 48200);
    try {
      const res = await fetch(`http://localhost:${port}/api/jobs`, { signal: AbortSignal.timeout(3000) });
      // Must be 503 (daemon unreachable) -- NEVER 500 (internal server error)
      assert.notEqual(res.status, 500, `GET /api/jobs returned 500 (Internal Server Error) -- unhandled exception in proxy`);
      assert.equal(res.status, 503, `Expected 503 daemon-not-running, got ${res.status}`);
    } finally {
      child.kill();
    }
  });
});
