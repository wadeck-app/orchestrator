'use strict';

// The CLI views of a job's output strip escape sequences by default (a program that ignores NO_COLOR, or a log
// written before the daemon stripped them), and keep them with --raw:
//   orch job-logs <id> [-f] [--json]     orch logs --job <id> [-f] [--json]     orch logs [-f]
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runCli } = require('../src/cli');

const JOB = 'dev-server';
const ESC = '\u001b';
const BEL = '\u0007';
const COLOURED = `${ESC}[90m${ESC}[2m(client)${ESC}[22m${ESC}[39m ready ${ESC}]0;title${BEL}in ${ESC}[1m120${ESC}[22m ms`;
const PLAIN = '(client) ready in 120 ms';

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-strip-ansi-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function runFile(startedAt) {
  return path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${startedAt.replace(/:/g, '-').slice(0, 19)}.log`);
}

function writeRun(startedAt, lines) {
  const f = runFile(startedAt);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

/** Runs the CLI with process.stdout.write and console.* captured; `jobLogs` hooks carry job-logs' own output. */
async function run(argv, { history = [], afterStart } = {}) {
  const out = [];
  const err = [];
  const origExit = process.exit;
  const origLog = console.log;
  const origCErr = console.error;
  const origWrite = process.stdout.write.bind(process.stdout);
  let exitCode = 0;
  console.log = (m) => { out.push(`${m}\n`); };
  console.error = (m) => { err.push(`${m}\n`); };
  // The test runner reports through this same stream, in Buffers; the CLI writes strings. Only strings are captured.
  process.stdout.write = (chunk, ...rest) => {
    if (typeof chunk === 'string') {
      out.push(chunk);
      return true;
    }
    return origWrite(chunk, ...rest);
  };
  process.exit = (code) => { exitCode = code ?? 0; throw Object.assign(new Error('exit'), { exitCode }); };
  try {
    const running = runCli(argv, {
      send: async (command) => {
        if (command === 'get-job') {
          return { id: JOB };
        }
        if (command === 'list-state') {
          return { [JOB]: history };
        }
        throw new Error(`unexpected command ${command}`);
      },
      startDaemon: () => {},
      configDir: dir,
      jobLogs: { pollMs: 10, stdout: (t) => { out.push(t); }, stderr: (t) => { err.push(t); } },
    });
    afterStart?.();
    await running;
  } catch (e) {
    if (e.message !== 'exit') {
      throw e;
    }
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origCErr;
    process.stdout.write = origWrite;
  }
  return { out: out.join(''), err: err.join(''), exitCode };
}

const A = '2026-10-20T03:00:00.000Z';
const stamped = (text) => `[2026-10-20 03:00:00] ${text}`;
const finished = { startedAt: A, finishedAt: '2026-10-20T03:00:12.000Z', exitCode: 0, pid: 1, triggeredBy: { kind: 'cron' } };

describe('orch job-logs', () => {
  test('strips escape sequences from the lines it prints, by default', async () => {
    writeRun(A, [stamped(COLOURED), stamped(`${ESC}[31m[stderr] boom${ESC}[0m`)]);
    const { out } = await run(['job-logs', JOB], { history: [finished] });
    assert.equal(out, `${stamped(PLAIN)}\n${stamped('[stderr] boom')}\n`);
  });

  test('--raw prints them as they are in the file', async () => {
    writeRun(A, [stamped(COLOURED)]);
    const { out } = await run(['job-logs', JOB, '--raw'], { history: [finished] });
    assert.equal(out, `${stamped(COLOURED)}\n`);
  });

  test('--json strips too, and --json --raw keeps them', async () => {
    writeRun(A, [stamped(COLOURED)]);
    const stripped = await run(['job-logs', JOB, '--json'], { history: [finished] });
    assert.deepEqual(JSON.parse(stripped.out), [{ t: '2026-10-20 03:00:00', text: PLAIN }]);
    const raw = await run(['job-logs', JOB, '--json', '--raw'], { history: [finished] });
    assert.deepEqual(JSON.parse(raw.out), [{ t: '2026-10-20 03:00:00', text: COLOURED }]);
  });

  test('-f strips the lines that were there and the lines that arrive', async () => {
    const f = writeRun(A, [stamped(COLOURED)]);
    setTimeout(() => fs.appendFileSync(f, `${stamped(`${ESC}[32mnew line${ESC}[0m`)}\n`), 60);
    setTimeout(() => fs.appendFileSync(f, `${stamped('[job:finished] exitCode=0 duration=1s')}\n`), 120);
    const { out } = await run(['job-logs', JOB, '-f'], { history: [{ ...finished, finishedAt: undefined, exitCode: null }] });
    assert.equal(out.includes(ESC), false, JSON.stringify(out));
    assert.ok(out.includes(`${stamped(PLAIN)}\n`));
    assert.ok(out.includes(`${stamped('new line')}\n`));
  });

  test('-f --raw keeps the sequences that arrive', async () => {
    const f = writeRun(A, [stamped('start')]);
    setTimeout(() => fs.appendFileSync(f, `${stamped(`${ESC}[32mnew line${ESC}[0m`)}\n`), 60);
    setTimeout(() => fs.appendFileSync(f, `${stamped('[job:finished] exitCode=0 duration=1s')}\n`), 120);
    const { out } = await run(['job-logs', JOB, '-f', '--raw'], { history: [{ ...finished, finishedAt: undefined, exitCode: null }] });
    assert.ok(out.includes(`${stamped(`${ESC}[32mnew line${ESC}[0m`)}\n`), JSON.stringify(out));
  });

  test('--raw with --list-runs is accepted and changes nothing', async () => {
    writeRun(A, [stamped('x')]);
    const { exitCode } = await run(['job-logs', JOB, '--list-runs', '--raw'], { history: [finished] });
    assert.equal(exitCode, 0);
  });
});

describe('orch logs --job', () => {
  const today = new Date().toISOString().slice(0, 10);
  const todayFile = () => {
    const f = path.join(dir, 'logs', 'jobs', JOB, `${JOB}-${today}T10-00-00.log`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    return f;
  };

  test('strips by default, also in the JSON a pipe gets', async () => {
    fs.writeFileSync(todayFile(), `${stamped(COLOURED)}\n`);
    const { out } = await run(['logs', '--job', JOB]);
    assert.equal(out.includes(ESC), false, JSON.stringify(out));
    assert.equal(JSON.parse(out.trim()).message, PLAIN);
  });

  test('--raw keeps them', async () => {
    fs.writeFileSync(todayFile(), `${stamped(COLOURED)}\n`);
    const { out } = await run(['logs', '--job', JOB, '--raw']);
    assert.equal(JSON.parse(out.trim()).message, COLOURED);
  });

  test('--follow strips the lines that arrive, --follow --raw does not', async () => {
    const f = todayFile();
    fs.writeFileSync(f, `${stamped('first')}\n`);
    const follow = async (extra) => {
      const { out } = await run(['logs', '--job', JOB, '--follow', ...extra], {
        afterStart: () => {
          setTimeout(() => fs.appendFileSync(f, `${stamped(COLOURED)}\n`), 150);
          setTimeout(() => process.emit('SIGINT'), 700);
        },
      });
      return out;
    };
    const stripped = await follow([]);
    assert.ok(stripped.includes(PLAIN), stripped);
    assert.equal(stripped.includes(ESC), false, JSON.stringify(stripped));
    const raw = await follow(['--raw']);
    assert.ok(raw.includes('title'), raw);
    assert.ok(JSON.stringify(raw).includes('\\u001b'), 'the escape sequences are kept with --raw');
  });
});

describe('orch logs (the daemon log)', () => {
  test('strips by default and keeps with --raw: it can hold the echo of a job run by an older daemon', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const f = path.join(dir, 'logs', 'daemon', `daemon-${today}.log`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${stamped(COLOURED)}\n`);
    const stripped = await run(['logs']);
    assert.equal(JSON.parse(stripped.out.trim()).message, PLAIN);
    const raw = await run(['logs', '--raw']);
    assert.equal(JSON.parse(raw.out.trim()).message, COLOURED);
  });
});

describe('orch --help', () => {
  test('documents --raw for job-logs and logs', async () => {
    const { out } = await run(['--help']);
    const raw = out.split('\n').filter((l) => l.includes('--raw'));
    assert.ok(raw.length >= 2, `--raw must be explained for both commands:\n${raw.join('\n')}`);
    assert.match(out, /jobsNoColor/);
  });
});
