// Test that the BUNDLED server starts correctly (simulates installed package context)
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const BUNDLED_BIN = 'packages/orchestrator-cli/server/index.mjs';
const configDir = join(homedir(), '.config', 'orch-test-bundled');

const child = spawn(process.execPath, [BUNDLED_BIN, '--config-dir', configDir, '--base-port', '47975'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});

createInterface({ input: child.stdout }).on('line', line => console.log('STDOUT:', line));
createInterface({ input: child.stderr }).on('line', line => {
  if (!line.includes('MODULE_TYPELESS') && !line.includes('Reparsing') && !line.includes('add "type"') && !line.includes('trace-warnings')) {
    console.log('STDERR:', line);
  }
});
child.on('exit', code => console.log('EXIT:', code));
setTimeout(() => { child.kill(); }, 5000);
