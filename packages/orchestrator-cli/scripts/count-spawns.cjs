'use strict';
/*
 * Preload (node --require) that counts every child process this node process starts, and says so at exit.
 * Diagnostic for the macOS `spawn EAGAIN` in CI: the question is which test files start processes in bulk.
 *
 *   node --require ./scripts/count-spawns.cjs --test --require tsx/cjs test/inspect-timers.test.js
 *
 * Prints one line per process to stderr: file, total spawns, the three most frequent commands.
 * Hooks ChildProcess.prototype.spawn, which spawn/exec/execFile/fork all end up in, and spawnSync, which
 * execSync/execFileSync end up in; patching child_process.spawn alone would miss exec and execFile.
 */
const cp = require('node:child_process');
const path = require('node:path');

const counts = new Map();
let total = 0;

function record(file) {
  total++;
  const name = path.basename(String(file));
  counts.set(name, (counts.get(name) ?? 0) + 1);
}

const originalSpawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function countedSpawn(options) {
  record(options?.file ?? '?');
  return originalSpawn.call(this, options);
};

const originalSpawnSync = cp.spawnSync;
cp.spawnSync = function countedSpawnSync(file, ...rest) {
  record(file);
  return originalSpawnSync.call(this, file, ...rest);
};

process.on('exit', () => {
  if (total === 0) {
    return;
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => `${name}x${n}`).join(' ');
  process.stderr.write(`[count-spawns] pid ${process.pid} ${path.basename(process.argv[1] ?? '?')}: ${total} spawns (${top})\n`);
});
