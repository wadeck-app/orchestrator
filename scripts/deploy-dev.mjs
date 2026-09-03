#!/usr/bin/env node
/**
 * deploy-dev.mjs — rebuild all packages and sync to the global orch install.
 * Run after any code change: node scripts/deploy-dev.mjs
 *
 * The global install at $(npm root -g)/@wadeck-app/orchestrator-cli/ is what
 * the running daemon actually uses — local packages/orchestrator-cli/dist/
 * is only the build target, not what orch server start runs.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const node = process.execPath;

function run(cmd, args, cwd = ROOT) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  // shell:true required on Windows for .cmd scripts (npm.cmd, etc.)
  // windowsHide:true prevents any CMD window from flashing on screen.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin, windowsHide: true });
}

// 1. Build orch-server
run(npm, ['run', 'build', '-w', '@wadeck-app/orch-server']);

// 2. Sync orch-server dist to orchestrator-cli/server/dist
cpSync(resolve(ROOT, 'packages/orch-server/dist'), resolve(ROOT, 'packages/orchestrator-cli/server/dist'), { recursive: true });
console.log('✓ synced orch-server dist');

// 3. Copy orch-app dist to both server public dirs
run(node, ['packages/orch-server/scripts/copy-app.mjs']);

// 4. Build orchestrator-cli
run(npm, ['run', 'build', '-w', '@wadeck-app/orchestrator-cli']);

// 5. Sync both to global install
// Resolve global node_modules from node executable (works with nvm symlinks)
const nodeDir = resolve(node, '..');                   // e.g. /c/App/nodejs
const globalRoot = resolve(nodeDir, '..', 'nvm', process.version, 'node_modules');
const globalPkg = resolve(globalRoot, '@wadeck-app/orchestrator-cli');
// Clean + copy: prevents stale asset hashes from accumulating in global install
function syncDir(src, dst) {
  if (existsSync(dst)) rmSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}
syncDir(resolve(ROOT, 'packages/orchestrator-cli/dist'), resolve(globalPkg, 'dist'));
syncDir(resolve(ROOT, 'packages/orchestrator-cli/server/dist'), resolve(globalPkg, 'server/dist'));
syncDir(resolve(ROOT, 'packages/orchestrator-cli/server/public'), resolve(globalPkg, 'server/public'));
console.log(`✓ synced to global install at ${globalPkg}`);

console.log('\nDone. Run: orch server stop && orch server start');
