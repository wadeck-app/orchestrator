#!/usr/bin/env node
/* ===========================================================================================
 *  ###############################################################################
 *  ##                                                                           ##
 *  ##   STOP. DEV NEVER GOES TO GLOBAL. NOT ONCE. NOT BEHIND A FLAG.             ##
 *  ##                                                                           ##
 *  ###############################################################################
 *
 *  DO NOT add a `--global` flag to this script. DO NOT copy dist/, server/dist/ or
 *  server/public/ into the globally installed @wadeck-app/orchestrator-cli. DO NOT write
 *  anywhere outside this repository. If you are reading this because you are about to add
 *  "just a small opt-in sync to test something quickly": that is the exact sentence that
 *  caused the incident described below. The answer is no.
 *
 *  There are EXACTLY TWO ways the machine's `orch` may change, and this script is neither:
 *
 *      npm install -g @wadeck-app/orchestrator-cli@latest
 *      orch cli update
 *
 *  Both install a PUBLISHED, COMMITTED version. That is the entire point.
 *
 *  WHAT HAPPENED WHEN THIS RULE DID NOT EXIST:
 *  A `--global` flag here copied the working tree - UNCOMMITTED WORK INCLUDED - over the
 *  installed package. The user's `orch` silently became a build that existed in no release
 *  and in no commit. It then took a reinstall to undo, and left an orphaned npm staging
 *  directory behind. Worse than the breakage: two later sessions read that install as
 *  evidence about the PUBLISHED package, and one nearly reported a packaging regression
 *  that was never real - it was only somebody's local build wearing the install's name.
 *
 *  A dev build that can become the machine's install is not a convenience, it is a
 *  corrupted source of truth. The capability is DELETED, not guarded, because a guarded
 *  one gets passed by whoever is in a hurry - and that was me.
 * ===========================================================================================
 */
/**
 * deploy-dev.mjs - rebuild every package into this checkout.
 * Run after any code change: node scripts/deploy-dev.mjs
 *
 * Nothing outside the repository is written, ever. To test a change, run the local CLI entry
 * point rather than the `orch` on PATH:
 *
 *   node scripts/dev-server.mjs
 *
 * dashboard-binary.ts resolves the server relative to its own __dirname, so
 * packages/orchestrator-cli/dist/orchestrator-cli.cjs runs this checkout's
 * server/dist and server/public - never the globally installed copy.
 *
 * There is deliberately no way to push a local build into the global install. The only ways to
 * change the machine's `orch` are the two that install a published, committed version:
 *
 *   npm install -g @wadeck-app/orchestrator-cli@latest
 *   orch cli update
 *
 * A `--global` flag used to do it from here. It copied the working tree - uncommitted work
 * included - over the installed package, so `orch` ran code that was in no release and in no
 * commit. Two sessions then read that install as evidence about the published package, and one
 * nearly reported a packaging regression that was only a local build. A dev build must not be
 * able to become the machine's install by accident, so the path is gone rather than guarded.
 *
 * IS THIS SCRIPT STILL USED? Yes (checked 2026-10-27). Do not delete it on a quick grep: the first search, limited to
 * .md/.ts/.js files, only found lessons-learned entries and made it look unused. What uses it:
 *   - the root package.json: `npm run deploy` runs it, and `npm run dev` runs it before scripts/dev-server.mjs;
 *   - scripts/dev-server.mjs: its "CLI not built" error tells the reader to run it;
 *   - the dashboard cannot be looked at without it: orch-app is built into orch-server/public by the steps below, and the dev
 *     server serves that copy, so a UI change is invisible until this has run.
 * To check again: `grep -rn deploy-dev --include=*.json --include=*.mjs --include=*.md --include=*.yml .` (not in node_modules,
 * .claude/logs) and read root package.json "scripts". It is not run by CI.
 */
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

// Rejected loudly rather than ignored. Anyone typing it believes it does something, and a flag
// that is silently a no-op would let them think the global install was updated when it was not.
if (process.argv.includes('--global')) {
  console.error('--global is not supported: a dev build must never overwrite the installed orch.');
  console.error('');
  console.error('To change the machine-wide `orch`, install a published version:');
  console.error('    npm install -g @wadeck-app/orchestrator-cli@latest');
  console.error('    orch cli update');
  console.error('');
  console.error('To run THIS checkout without touching the install:');
  console.error('    node scripts/dev-server.mjs');
  process.exit(2);
}

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const node = process.execPath;

function run(cmd, args, cwd = ROOT) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  // windowsHide:true prevents any CMD window from flashing on screen.
  if (isWin && cmd === npm) {
    // npm.cmd needs a shell on Windows. One command string, not execFileSync(cmd, args, { shell: true }): Node deprecates the args
    // array with a shell (DEP0190) because it only concatenates the pieces. An argument with a blank would be cut by the shell, so
    // it is refused rather than run wrong.
    const blank = args.find((a) => /\s/.test(a));
    if (blank !== undefined) {
      throw new Error(`deploy-dev: the npm argument "${blank}" contains a blank, which cmd.exe would split. Use a name without one.`);
    }
    execSync(`${cmd} ${args.join(' ')}`, { cwd, stdio: 'inherit', windowsHide: true });
    return;
  }
  // node itself needs no shell, so an install path with a blank in it (a Program Files install) stays one word.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', windowsHide: true });
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

// 1. Build the front end, before anything copies its output.
//
// These two were missing entirely: the script built orch-server and orchestrator-cli, then copied
// orch-app/dist into the server's public dir - whatever was in it. So "rebuild every package",
// which is what the header promised, silently shipped a stale bundle, and every UI change tested
// through `node scripts/dev-server.mjs` was tested against the previous build. The dist was over an
// hour old when this was found, and the change under test simply was not in the page.
// orch-app imports the components from @wadeck-app/dsl-lib-orch sources (no build step of its own), and its registry
// entries are generated from them.
run(npm, ['run', 'build', '-w', '@wadeck-app/orch-app']);

// 2. Build orch-server
run(npm, ['run', 'build', '-w', '@wadeck-app/orch-server']);

// 3. Sync orch-server dist to orchestrator-cli/server/dist
syncDir(resolve(ROOT, 'packages/orch-server/dist'), resolve(ROOT, 'packages/orchestrator-cli/server/dist'));
console.log('✓ synced orch-server dist');

// 4. Copy orch-app dist to both server public dirs
run(node, ['packages/orch-server/scripts/copy-app.mjs']);

// 5. Build orchestrator-cli, then BUNDLE it.
//
// The bundle is the part that actually runs. `build` is tsc, which emits dist/*.js per file, while
// dev-server.mjs launches dist/orchestrator-cli.cjs and the daemon entry is dist/orchestrator.cjs -
// both produced only by `bundle`. Without this step the dev daemon ran whatever bundle happened to
// be on disk: measured four hours stale, so a whole afternoon of daemon-side fixes were absent from
// the thing being tested while tsc reported success. Exactly the orch-app staleness again, one
// package over.
run(npm, ['run', 'build', '-w', '@wadeck-app/orchestrator-cli']);
run(npm, ['run', 'bundle', '-w', '@wadeck-app/orchestrator-cli']);

// 6. Report where the build went, and where it did NOT go. There is no step 7: see the banner.
console.log('\n✓ Built into this checkout. The global install was NOT touched, and cannot be.');
console.log('  Run the dashboard on this build, isolated from the real config dir:');
console.log('    node scripts/dev-server.mjs          # add --seed to copy the real job list');
console.log('  To change the machine-wide `orch`: npm install -g @wadeck-app/orchestrator-cli@latest');
