#!/usr/bin/env node
/**
 * deploy-dev.mjs - rebuild every package into this checkout.
 * Run after any code change: node scripts/deploy-dev.mjs
 *
 * By default nothing outside the repository is written. To test a change, run
 * the local CLI entry point rather than the `orch` on PATH:
 *
 *   node scripts/dev-server.mjs
 *
 * dashboard-binary.ts resolves the server relative to its own __dirname, so
 * packages/orchestrator-cli/dist/orchestrator-cli.cjs runs this checkout's
 * server/dist and server/public - never the globally installed copy.
 *
 * `--global` additionally overwrites the globally installed package with these
 * local builds. That mutates the `orch` command the machine uses outside this
 * repo, including from uncommitted work, so it is opt-in and never implied by a
 * plain build.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const SYNC_GLOBAL = process.argv.includes('--global');

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const node = process.execPath;

function run(cmd, args, cwd = ROOT) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  // shell:true required on Windows for .cmd scripts (npm.cmd, etc.)
  // windowsHide:true prevents any CMD window from flashing on screen.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin, windowsHide: true });
}

/**
 * Replaces dst with src. The clean matters as much as the copy: cpSync only adds, so a plain
 * recursive copy leaves behind every file that no longer exists in src -- renamed asset hashes,
 * modules deleted from the sources, and a nested server/dist/dist/ that no step ever removed and
 * that every deploy then carried forward into the global install.
 */
function syncDir(src, dst) {
  if (existsSync(dst)) rmSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true });
}

// 1. Build orch-server
run(npm, ['run', 'build', '-w', '@wadeck-app/orch-server']);

// 2. Sync orch-server dist to orchestrator-cli/server/dist
syncDir(resolve(ROOT, 'packages/orch-server/dist'), resolve(ROOT, 'packages/orchestrator-cli/server/dist'));
console.log('✓ synced orch-server dist');

// 3. Copy orch-app dist to both server public dirs
run(node, ['packages/orch-server/scripts/copy-app.mjs']);

// 4. Build orchestrator-cli
run(npm, ['run', 'build', '-w', '@wadeck-app/orchestrator-cli']);

// 5. Overwrite the global install, only when asked. The flag existed but was never read, so the
// header's promise that nothing outside the repository is written was false and every plain build
// still replaced the machine's `orch`.
if (SYNC_GLOBAL) {
  // Resolve global node_modules from node executable (works with nvm symlinks)
  const nodeDir = resolve(node, '..');                   // e.g. /c/App/nodejs
  const globalRoot = resolve(nodeDir, '..', 'nvm', process.version, 'node_modules');
  const globalPkg = resolve(globalRoot, '@wadeck-app/orchestrator-cli');
  syncDir(resolve(ROOT, 'packages/orchestrator-cli/dist'), resolve(globalPkg, 'dist'));
  syncDir(resolve(ROOT, 'packages/orchestrator-cli/server/dist'), resolve(globalPkg, 'server/dist'));
  syncDir(resolve(ROOT, 'packages/orchestrator-cli/server/public'), resolve(globalPkg, 'server/public'));
  // Sync runtime deps that aren't in the published package (added locally)
  const runtimeDeps = ['pidusage'];
  for (const dep of runtimeDeps) {
    const src = resolve(ROOT, 'node_modules', dep);
    const dst = resolve(globalRoot, dep);
    if (existsSync(src)) { syncDir(src, dst); }
  }
  console.log(`✓ synced to global install at ${globalPkg}`);

  // Said out loud on purpose. The install is no longer what npm shipped, uncommitted work included.
  // Two sessions each treated it as evidence about the published package, and one nearly reported a
  // packaging regression that was only a local build.
  const dirty = execFileSync('git', ['status', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
  console.log('\n! The global install is now your working tree, not the npm package.');
  if (dirty) {
    console.log(`  ${dirty.split('\n').length} uncommitted file(s) are live in it, so \`orch\` runs code that is not in git.`);
  }
  console.log('  To check what npm actually ships, use `npm pack`, not this install.');
  console.log('  To restore it: npm install -g @wadeck-app/orchestrator-cli@latest');
  console.log('\nDone. Run: orch server stop && orch server start');
} else {
  console.log('\n✓ Built into this checkout. The global install was NOT touched.');
  console.log('  Run the dashboard on this build, isolated from the real config dir:');
  console.log('    node scripts/dev-server.mjs          # add --seed to copy the real job list');
  console.log('  To overwrite the machine-wide `orch` with this build: npm run deploy -- --global');
}
