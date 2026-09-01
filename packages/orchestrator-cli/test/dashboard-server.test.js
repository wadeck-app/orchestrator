'use strict';

/**
 * Integration test: verifies orch-server starts, serves the heartbeat,
 * and the CLI server-binary self-check passes.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { createInterface } = require('node:readline');

const SERVER_BIN = path.join(__dirname, '..', 'server', 'dist', 'index.js');
const CONFIG_DIR = path.join(os.tmpdir(), `orch-server-test-${Date.now()}`);
const BASE_PORT = 48100;

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_BIN, '--config-dir', CONFIG_DIR, '--base-port', String(BASE_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    const errors = [];

    createInterface({ input: child.stderr }).on('line', (line) => {
      // Ignore the MODULE_TYPELESS_PACKAGE_JSON warning
      if (!line.includes('MODULE_TYPELESS_PACKAGE_JSON') && !line.includes('Reparsing') && !line.includes('add "type"') && !line.includes('trace-warnings')) {
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
        if (msg.type === 'ready') {
          clearTimeout(timer);
          resolve({ child, port: msg.port });
        }
      } catch { /* ignore non-JSON */ }
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== null && code !== 0) {
        reject(new Error(`Server exited with code ${code}. stderr: ${errors.join('\n')}`));
      }
    });
  });
}

describe('orch-server integration', () => {
  test('server binary exists', () => {
    assert.ok(fs.existsSync(SERVER_BIN), `server binary not found at ${SERVER_BIN}`);
  });

  test('server starts and responds to heartbeat', async () => {
    const { child, port } = await startServer();
    try {
      const res = await fetch(`http://localhost:${port}/api/heartbeat`, {
        method: 'POST',
        signal: AbortSignal.timeout(2000),
      });
      assert.equal(res.status, 204, 'heartbeat should return 204');

      const res2 = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(2000) });
      assert.equal(res2.status, 200, 'SPA index.html should return 200');
    } finally {
      child.kill();
    }
  });
});
