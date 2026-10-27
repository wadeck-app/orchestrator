'use strict';

// Run by no-deprecations.test.js with --throw-deprecation: `orch exec` through ExecManager's own default spawn.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ExecManager } = require('../../src/exec-manager');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-defspawn-'));
const manager = new ExecManager(dir, { publish() {} });
const { runId } = manager.fireExec(process.argv[2]);
const child = manager._pids.get(runId);
child.once('error', (err) => { process.stderr.write(`spawn failed: ${err.message}\n`); process.exit(2); });
child.once('close', (code) => { process.exit(code === 0 ? 0 : 3); });
