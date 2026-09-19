// Measure the wall-clock cost of each test file, one at a time, slowest first.
// Diagnostic only -- `npm test` runs them in parallel, so the sum here is an upper bound.
// Usage: node scripts/time-tests.mjs
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const testDir = path.join(import.meta.dirname, '..', 'test');
const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

const results = [];
for (const file of files) {
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ['--test', '--require', 'tsx/cjs', path.join('test', file)],
    // windowsHide: a script meant to be run repeatedly must not flash 54 console windows.
    { cwd: path.join(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true },
  );
  results.push({ file, ms: Date.now() - started, code: res.status });
}

results.sort((a, b) => b.ms - a.ms);
let total = 0;
for (const r of results) {
  total += r.ms;
  const flag = r.code === 0 ? ' ' : 'FAIL';
  console.log(`${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${flag.padEnd(4)}  ${r.file}`);
}
console.log(`\ntotal serial: ${(total / 1000).toFixed(1)}s over ${results.length} files`);
