// Measure the wall-clock cost of each test file, one at a time, slowest first.
//
// Diagnostic only -- `npm test` runs files in parallel, so the sum here is an upper bound and the
// per-file figures are what it is for: they are what showed that two files were 47s of a 72s total
// while the other 52 were 0.1-0.9s each, which is the opposite of what the plan had assumed.
//
// Usage: npm run test:time  (or: node scripts/time-tests.mjs)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

// A file that hangs must not hang this script. Generous, since the point is to find slow files.
const PER_FILE_TIMEOUT_MS = 180_000;

const packageDir = path.join(import.meta.dirname, '..');
const testDir = path.join(packageDir, 'test');
// Not recursive, and `npm test` globs test/**/*.test.js. They agree only while test/ stays flat, so
// say so rather than silently measuring a different set than CI runs.
const entries = readdirSync(testDir, { withFileTypes: true });
if (entries.some(e => e.isDirectory())) {
  console.error(`test/ has subdirectories; this script only walks the top level and would measure a`
    + ` different set than \`npm test\`. Make it recursive before trusting these numbers.`);
  process.exit(2);
}
const files = entries.filter(e => e.isFile() && e.name.endsWith('.test.js')).map(e => e.name).sort();

const results = [];
for (const file of files) {
  process.stderr.write(`  measuring ${file}\r`);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    ['--test', '--require', 'tsx/cjs', path.join('test', file)],
    {
      cwd: packageDir,
      encoding: 'utf8',
      // windowsHide: a script meant to be run repeatedly must not flash one console window per file.
      windowsHide: true,
      timeout: PER_FILE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    },
  );
  results.push({ file, ms: Date.now() - started, res });
}
process.stderr.write(' '.repeat(40) + '\r');

results.sort((a, b) => b.ms - a.ms);
let total = 0;
const failed = [];
for (const r of results) {
  total += r.ms;
  // spawnSync reports a timeout or an ENOENT through `error` with a null status, so a bare
  // `status === 0` check would print a plain FAIL and throw away the only useful information.
  const ok = r.res.error === undefined && r.res.status === 0;
  if (!ok) failed.push(r);
  console.log(`${String((r.ms / 1000).toFixed(1)).padStart(6)}s  ${(ok ? '' : 'FAIL').padEnd(4)}  ${r.file}`);
}
console.log(`\ntotal serial: ${(total / 1000).toFixed(1)}s over ${results.length} files`);

// Output, not just a flag. Knowing a file failed without knowing why means running it again by hand,
// which is the whole cost this script was meant to remove.
for (const r of failed) {
  console.log(`\n${'='.repeat(70)}\nFAILED: ${r.file}`);
  if (r.res.error) {
    console.log(`could not run it at all: ${r.res.error.message}`);
    if (r.res.error.code === 'ETIMEDOUT') {
      console.log(`it was killed after ${PER_FILE_TIMEOUT_MS}ms, so it hangs rather than fails.`);
    }
  } else {
    console.log(`exit code ${r.res.status}`);
  }
  const output = `${r.res.stdout ?? ''}${r.res.stderr ?? ''}`.trimEnd();
  if (output) console.log(output);
}

// Non-zero on failure, so this can gate something if anyone wants it to.
process.exit(failed.length > 0 ? 1 : 0);
