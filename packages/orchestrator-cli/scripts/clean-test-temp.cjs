'use strict';

/*
 * Removes what earlier test runs left in the OS temp dir: its direct children named orch-*, older than a given age.
 *
 *   node scripts/clean-test-temp.cjs [--older-than-minutes N] [--dry-run]
 *
 * `npm test` runs it first (pretest). The default age is 30 minutes so a run in progress, yours or another session's,
 * is never touched. Nothing outside the temp dir and nothing that does not start with "orch-" is looked at, and a
 * link is removed as a link, never followed. A folder that cannot be removed (a job a test left running holds a file)
 * is counted and named in the summary, not hidden.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'orch-';
const DEFAULT_MINUTES = 30;

function parseArgs(argv) {
  const out = { minutes: DEFAULT_MINUTES, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
    } else if (arg === '--older-than-minutes') {
      const value = argv[i + 1];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error(`--older-than-minutes needs a whole number of minutes (0 or more), got ${value === undefined ? 'nothing' : JSON.stringify(value)}.\nUsage: node scripts/clean-test-temp.cjs [--older-than-minutes N] [--dry-run]`);
      }
      out.minutes = Number(value);
      i++;
    } else {
      throw new Error(`Unknown argument ${JSON.stringify(arg)}. Usage: node scripts/clean-test-temp.cjs [--older-than-minutes N] [--dry-run]`);
    }
  }
  return out;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`clean-test-temp: ${err.message}\n`);
    process.exit(4);
  }

  const temp = os.tmpdir();
  const limit = Date.now() - options.minutes * 60_000;
  let removed = 0;
  let recent = 0;
  const stuck = [];

  for (const name of fs.readdirSync(temp)) {
    if (!name.startsWith(PREFIX)) {
      continue;
    }
    const target = path.join(temp, name);
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      continue;
    }
    if (stat.mtimeMs > limit) {
      recent++;
      continue;
    }
    if (options.dryRun) {
      removed++;
      continue;
    }
    try {
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(target);
      } else {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
      removed++;
    } catch (err) {
      stuck.push(`${name} (${err.code ?? err.message})`);
    }
  }

  const verb = options.dryRun ? 'would remove' : 'removed';
  process.stdout.write(`clean-test-temp: ${verb} ${removed} ${PREFIX}* folder(s) older than ${options.minutes} min in ${temp}; kept ${recent} recent one(s)\n`);
  if (stuck.length > 0) {
    process.stdout.write(`clean-test-temp: ${stuck.length} could not be removed, probably held by a running process: ${stuck.slice(0, 5).join(', ')}${stuck.length > 5 ? ', ...' : ''}\n`);
  }
}

main();
