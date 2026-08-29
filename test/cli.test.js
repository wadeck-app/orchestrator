'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { runCli } = require('../src/cli');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(overrides = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      // RPC-style send: (command, payload?) => result
      send: async (command, payload) => {
        calls.push({ command, payload });
        return overrides.sendResult ?? {};
      },
      startDaemon: async () => { calls.push({ command: 'START_DAEMON' }); },
      configDir: '/tmp/orch-test',
      ...overrides.deps,
    },
  };
}

async function run(argv, overrides = {}) {
  const { calls, deps } = makeDeps(overrides);
  let exitCode = 0;
  const origExit = process.exit;
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  try {
    await runCli(argv, deps);
  } catch (e) {
    if (e.message !== 'exit') throw e;
  } finally {
    process.exit = origExit;
  }
  return { calls, exitCode };
}

// ---------------------------------------------------------------------------
// Job inspection
// ---------------------------------------------------------------------------

describe('orch list', () => {
  test('calls list-jobs', async () => {
    const { calls } = await run(['list'], { sendResult: [] });
    assert.equal(calls[0].command, 'list-jobs');
  });

  test('list --verbose still calls list-jobs', async () => {
    const { calls } = await run(['list', '--verbose'], { sendResult: [] });
    assert.equal(calls[0].command, 'list-jobs');
  });
});

describe('orch show', () => {
  test('calls get-job with id', async () => {
    const { calls } = await run(['show', 'my-job'], { sendResult: { id: 'my-job' } });
    assert.equal(calls[0].command, 'get-job');
    assert.equal(calls[0].payload.id, 'my-job');
  });
});

describe('orch status', () => {
  test('calls version', async () => {
    const { calls } = await run(['status'], { sendResult: { pid: 1, port: 47900 } });
    assert.equal(calls[0].command, 'version');
  });
});

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

describe('orch stop', () => {
  test('calls quit', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stop-test-'));
    fs.writeFileSync(path.join(dir, 'config.port'), JSON.stringify({ pid: process.pid, port: 47900 }));
    try {
      const { calls } = await run(['stop'], { deps: { configDir: dir } });
      assert.equal(calls[0].command, 'quit');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('prints not running when daemon is down', async () => {
    const { calls } = await run(['stop']);
    assert.equal(calls.length, 0);
  });
});

describe('orch restart', () => {
  test('calls restart', async () => {
    const { calls } = await run(['restart']);
    assert.equal(calls[0].command, 'restart');
  });
});

// ---------------------------------------------------------------------------
// Add cron
// ---------------------------------------------------------------------------

describe('orch add cron', () => {
  test('calls add-job with correct payload', async () => {
    const { calls } = await run([
      'add', 'cron', 'my-cron',
      '--schedule', '0 8 * * *',
      '--command', 'npm run scrape',
    ]);
    assert.equal(calls[0].command, 'add-job');
    assert.equal(calls[0].payload.id, 'my-cron');
    assert.equal(calls[0].payload.type, 'cron');
    assert.equal(calls[0].payload.schedule, '0 8 * * *');
    assert.equal(calls[0].payload.command, 'npm run scrape');
  });

  test('--disabled sets enabled=false', async () => {
    const { calls } = await run(['add', 'cron', 'x', '--schedule', '0 8 * * *', '--command', 'echo hi', '--disabled']);
    assert.equal(calls[0].payload.enabled, false);
  });

  test('exits 4 if --schedule missing', async () => {
    const { exitCode } = await run(['add', 'cron', 'x', '--command', 'echo hi']);
    assert.equal(exitCode, 4);
  });

  test('exits 4 if --command missing', async () => {
    const { exitCode } = await run(['add', 'cron', 'x', '--schedule', '0 8 * * *']);
    assert.equal(exitCode, 4);
  });
});

// ---------------------------------------------------------------------------
// Add startup
// ---------------------------------------------------------------------------

describe('orch add startup', () => {
  test('calls add-job with correct payload', async () => {
    const { calls } = await run([
      'add', 'startup', 'wdrive',
      '--command', '/usr/bin/wdrive',
      '--delay', '30',
    ]);
    assert.equal(calls[0].command, 'add-job');
    assert.equal(calls[0].payload.type, 'startup');
    assert.equal(calls[0].payload.delaySeconds, 30);
    assert.equal(calls[0].payload.command, '/usr/bin/wdrive');
  });

  test('exits 4 if --command missing', async () => {
    const { exitCode } = await run(['add', 'startup', 'x']);
    assert.equal(exitCode, 4);
  });
});

// ---------------------------------------------------------------------------
// Mutation commands
// ---------------------------------------------------------------------------

describe('orch remove', () => {
  test('calls remove-job with id', async () => {
    const { calls } = await run(['remove', 'my-job']);
    assert.equal(calls[0].command, 'remove-job');
    assert.equal(calls[0].payload.id, 'my-job');
  });
});

describe('orch enable / disable', () => {
  test('enable calls enable-job with id', async () => {
    const { calls } = await run(['enable', 'my-job']);
    assert.equal(calls[0].command, 'enable-job');
    assert.equal(calls[0].payload.id, 'my-job');
  });

  test('disable calls disable-job with id', async () => {
    const { calls } = await run(['disable', 'my-job']);
    assert.equal(calls[0].command, 'disable-job');
    assert.equal(calls[0].payload.id, 'my-job');
  });
});

describe('orch edit', () => {
  test('calls edit-job with id and updates', async () => {
    const { calls } = await run(['edit', 'my-job', '--label', 'New label']);
    assert.equal(calls[0].command, 'edit-job');
    assert.equal(calls[0].payload.id, 'my-job');
    assert.equal(calls[0].payload.updates.label, 'New label');
    assert.equal(Object.keys(calls[0].payload.updates).length, 1);
  });
});

describe('orch trigger', () => {
  test('fire-and-forget by default', async () => {
    const { calls } = await run(['trigger', 'my-job']);
    assert.equal(calls[0].command, 'trigger-job');
    assert.equal(calls[0].payload.id, 'my-job');
    assert.equal(calls[0].payload.wait, false);
  });

  test('--wait sets wait:true', async () => {
    const { calls } = await run(['trigger', 'my-job', '--wait']);
    assert.equal(calls[0].payload.wait, true);
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('unknown command', () => {
  test('exits with code 1', async () => {
    const { exitCode } = await run(['foobar']);
    assert.equal(exitCode, 1);
  });
});

// ---------------------------------------------------------------------------
// orch logs (top-level alias, Decision #TBD)
// ---------------------------------------------------------------------------

describe('orch logs (top-level)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  test('does not exit with error when log file exists', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-test-'));
    const logsDir = path.join(dir, 'logs');
    fs.mkdirSync(logsDir);
    const today = new Date().toISOString().slice(0, 10);
    const logFile = path.join(logsDir, `${today}.ndjson`);
    fs.writeFileSync(logFile, 'test log line\n');
    try {
      const written = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { written.push(chunk); return true; };
      const { exitCode } = await run(['logs'], { deps: { configDir: dir } });
      process.stdout.write = origWrite;
      assert.equal(exitCode, 0, 'orch logs must exit 0 when log file exists');
      assert.ok(written.join('').includes('test log line'), 'orch logs must print log contents');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });

  test('prints message and exits 0 when no log file for today', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logs-nofile-'));
    try {
      const written = [];
      const origWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk) => { written.push(chunk); return true; };
      const { exitCode } = await run(['logs'], { deps: { configDir: dir } });
      process.stdout.write = origWrite;
      assert.equal(exitCode, 0, 'orch logs must exit 0 with helpful message when no log file');
      assert.ok(written.join('').includes('No log file'), 'must mention missing log file');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --version, --pid, --help (Decision #20)
// ---------------------------------------------------------------------------

describe('--version', () => {
  test('prints version string and does not call send', async () => {
    const output = [];
    const origLog = console.log;
    console.log = (...a) => output.push(a.join(' '));
    try {
      const { calls } = await run(['--version']);
      assert.equal(calls.length, 0, '--version must not call send');
      assert.ok(output.length > 0, '--version must print something');
      assert.ok(output[0].length > 0, 'version string must be non-empty');
    } finally { console.log = origLog; }
  });
});

describe('--help', () => {
  test('prints help text and does not call send', async () => {
    const output = [];
    const origLog = console.log;
    console.log = (...a) => output.push(a.join(' '));
    try {
      const { calls } = await run(['--help']);
      assert.equal(calls.length, 0, '--help must not call send');
      assert.ok(output.join('\n').includes('orch'), 'help must mention orch');
    } finally { console.log = origLog; }
  });

  test('help command alias also works', async () => {
    const output = [];
    const origLog = console.log;
    console.log = (...a) => output.push(a.join(' '));
    try {
      await run(['help']);
      assert.ok(output.join('\n').length > 0, 'help must print something');
    } finally { console.log = origLog; }
  });
});

// ---------------------------------------------------------------------------
// --json flag (Decision #21)
// ---------------------------------------------------------------------------

describe('--json flag', () => {
  test('orch list --json outputs JSON array', async () => {
    const jobs = [{ id: 'test-job', type: 'cron', enabled: true, schedule: '0 * * * *' }];
    const output = [];
    const origLog = console.log;
    console.log = (...a) => output.push(a.join(' '));
    try {
      await run(['list', '--json'], { sendResult: jobs });
      const parsed = JSON.parse(output[0]);
      assert.ok(Array.isArray(parsed), '--json list must output JSON array');
      assert.equal(parsed[0].id, 'test-job');
    } finally { console.log = origLog; }
  });

  test('orch show --json outputs JSON object', async () => {
    const job = { id: 'test-job', type: 'cron' };
    const output = [];
    const origLog = console.log;
    console.log = (...a) => output.push(a.join(' '));
    try {
      await run(['show', 'test-job', '--json'], { sendResult: job });
      const parsed = JSON.parse(output[0]);
      assert.equal(parsed.id, 'test-job');
    } finally { console.log = origLog; }
  });
});

// ---------------------------------------------------------------------------
// orch cli self-check (D24 auto-update validation)
// ---------------------------------------------------------------------------

describe('orch cli self-check', () => {
  test('self-check exits 0 in quiet mode (no daemon required)', async () => {
    const { runCli } = require('../src/cli.ts');
    let exitCode = null;
    const origExit = process.exit;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.exit = (code) => { exitCode = code; throw new Error(`exit:${code}`); };
    const origEnv = process.env['CLI_SELF_CHECK_QUIET'];
    process.env['CLI_SELF_CHECK_QUIET'] = '1';
    try {
      await runCli(['cli', 'self-check'], {
        send: async () => ({}),
        startDaemon: () => {},
        configDir: require('node:os').tmpdir(),
      });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('exit:')) throw e;
    } finally {
      process.exit = origExit;
      process.env['CLI_SELF_CHECK_QUIET'] = origEnv;
    }
    assert.equal(exitCode, 0, 'self-check should exit 0 when all checks pass');
  });

  test('unknown cli subcommand exits 1', async () => {
    const { runCli } = require('../src/cli.ts');
    let exitCode = null;
    const origExit = process.exit;
    const origErr = console.error;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.exit = (code) => { exitCode = code; throw new Error(`exit:${code}`); };
    console.error = () => {};
    try {
      await runCli(['cli', 'unknown-cmd'], {
        send: async () => ({}),
        startDaemon: () => {},
        configDir: require('node:os').tmpdir(),
      });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('exit:')) throw e;
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    assert.equal(exitCode, 1);
  });

  test('self-check writes output to stderr (Go launcher compat)', async () => {
    const { runSelfCheck } = require('../src/self-check.ts');
    const stderrLines = [];
    const origErr = console.error;
    const origLog = console.log;
    const origExit = process.exit;
    console.error = (...a) => stderrLines.push(a.join(' '));
    // console.log must not be called — detect if it is
    const stdoutLines = [];
    console.log = (...a) => stdoutLines.push(a.join(' '));
    process.exit = (code) => { throw Object.assign(new Error('exit'), { exitCode: code }); };
    try {
      await runSelfCheck(false);
    } catch (e) {
      if (!e || e.message !== 'exit') throw e;
    } finally {
      console.error = origErr;
      console.log = origLog;
      process.exit = origExit;
    }
    assert.ok(stderrLines.length > 0, 'self-check must write to stderr');
    assert.ok(stderrLines.join('\n').includes('[ok]') || stderrLines.join('\n').includes('self-check'), 'stderr must include check output');
    assert.equal(stdoutLines.length, 0, 'self-check must not write to stdout (console.log)');
  });

  test('CLI_SELF_CHECK_QUIET suppresses all output', async () => {
    const { runCli } = require('../src/cli.ts');
    const origExit = process.exit;
    const origLog = console.log;
    const origErr = console.error;
    const logged = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    process.exit = (code) => { throw new Error(`exit:${code}`); };
    console.log = (...a) => logged.push(a.join(' '));
    console.error = (...a) => logged.push(a.join(' '));
    process.env['CLI_SELF_CHECK_QUIET'] = '1';
    try {
      await runCli(['cli', 'self-check'], {
        send: async () => ({}),
        startDaemon: () => {},
        configDir: require('node:os').tmpdir(),
      });
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith('exit:')) throw e;
    } finally {
      process.exit = origExit;
      console.log = origLog;
      console.error = origErr;
      delete process.env['CLI_SELF_CHECK_QUIET'];
    }
    assert.equal(logged.length, 0, 'quiet mode must produce no output');
  });
});
