'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

/*
 * A spent `once` job stays in the registry now, so `orch list` would grow a line per one-off job ever
 * run -- up to the retention bound, fifty of them -- burying the jobs that still have a firing ahead.
 *
 * Past once jobs are therefore hidden by default and shown with `--past`, and the count of what is
 * hidden is printed rather than left to be discovered: a job the user knows they created and cannot
 * find in `orch list` reads as data loss.
 */

function makeDeps(jobs) {
  return {
    send: async (command) => {
      if (command === 'list-jobs') {
        return jobs;
      }
      return {};
    },
    startDaemon: async () => {},
    configDir: '/tmp/orch-test',
  };
}

/*
 * isTTY is faked because the human-readable rendering is only reached when stdout is a terminal, and
 * a test runner's stdout never is. Without this every assertion below would be made against the JSON
 * branch, which is a different code path from the one a user sees.
 */
async function runList(argv, jobs, { tty = true } = {}) {
  const lines = [];
  const origLog = console.log;
  const origTty = process.stdout.isTTY;
  console.log = (...args) => { lines.push(args.join(' ')); };
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  try {
    await runCli(argv, makeDeps(jobs));
  } finally {
    console.log = origLog;
    Object.defineProperty(process.stdout, 'isTTY', { value: origTty, configurable: true });
  }
  return lines.join('\n');
}

const PENDING = {
  id: 'deploy-later', type: 'once', command: 'echo go', label: 'deploy-later',
  enabled: true, triggerMode: 'fire-and-forget',
  delayMs: 3_600_000, scheduledAt: new Date().toISOString(),
};
const SPENT = {
  id: 'deploy-done', type: 'once', command: 'echo done', label: 'deploy-done',
  enabled: true, triggerMode: 'fire-and-forget',
  delayMs: 1000, scheduledAt: new Date(Date.now() - 86_400_000).toISOString(),
  spent: true, spentAt: new Date(Date.now() - 86_400_000).toISOString(),
};
const CRON = {
  id: 'nightly', type: 'cron', command: 'echo tick', label: 'nightly',
  enabled: true, triggerMode: 'fire-and-forget', schedule: '0 3 * * *',
};

describe('orch list hides past once jobs', () => {
  test('a spent job is absent by default', async () => {
    const out = await runList(['list'], [CRON, PENDING, SPENT]);
    assert.doesNotMatch(out, /deploy-done/, 'a spent once job showed up in the default list');
    assert.match(out, /deploy-later/, 'the pending once job was hidden too');
    assert.match(out, /nightly/, 'the cron job was hidden');
  });

  test('--past shows it', async () => {
    const out = await runList(['list', '--past'], [CRON, PENDING, SPENT]);
    assert.match(out, /deploy-done/, '--past did not show the spent job');
  });

  test('the hidden count is stated, with the flag that reveals them', async () => {
    const out = await runList(['list'], [CRON, PENDING, SPENT]);
    assert.match(out, /1 past once job/, `the hidden job was not mentioned: ${out}`);
    assert.match(out, /--past/, 'the message does not say how to see them');
  });

  test('nothing is said when there is nothing hidden', async () => {
    const out = await runList(['list'], [CRON, PENDING]);
    assert.doesNotMatch(out, /past once/, `mentioned a hidden job that does not exist: ${out}`);
  });

  test('a registry holding only spent jobs does not read as empty', async () => {
    const out = await runList(['list'], [SPENT]);
    assert.doesNotMatch(out, /No jobs registered/, 'reported an empty registry that has a job in it');
    assert.match(out, /past once job/);
  });
});

describe('orch list --json', () => {
  test('the same filtering applies, so an agent sees the same default view', async () => {
    const out = await runList(['list', '--json'], [CRON, PENDING, SPENT]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.map(j => j.id), ['nightly', 'deploy-later']);
  });

  test('--past --json includes it', async () => {
    const out = await runList(['list', '--past', '--json'], [CRON, PENDING, SPENT]);
    const parsed = JSON.parse(out);
    assert.deepEqual(parsed.map(j => j.id).sort(), ['deploy-done', 'deploy-later', 'nightly']);
  });
});

describe('a past once job says when it fired', () => {
  test('the schedule column reads "fired ..." rather than a countdown to a moment long gone', async () => {
    const out = await runList(['list', '--past'], [SPENT]);
    assert.match(out, /fired/, `a spent job showed no sign of having run: ${out}`);
    assert.doesNotMatch(out, /overdue/, 'a job that already ran was called overdue');
  });
});
