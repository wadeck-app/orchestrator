'use strict';

// A job started under the supervisor: the daemon writes a spec, starts the supervisor detached, and then only
// reads files. These tests run the REAL supervisor binary, because the contract between the two is the
// thing being tested; a double would only prove that the daemon agrees with itself.
const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');

const { findSupervisorBinary } = require('../src/platform-binary');
const { startSupervised, SupervisedChild } = require('../src/supervised-run');

const supervisorPath = findSupervisorBinary();
if (supervisorPath === null) {
  throw new Error(
    'No supervisor binary for this platform. Build it with: npm run build-supervisor --workspace=packages/orchestrator-cli '
    + '(needs Go). This test does not skip: a skipped test would report a green run that exercised nothing.',
  );
}

const dirs = [];
const children = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-supervised-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (children.length > 0) {
    const child = children.pop();
    try { child.requestKill('test-cleanup'); } catch { /* already gone */ }
  }
});

/** A job written as a script, so quoting is the same under cmd.exe and sh. */
function scriptCommand(dir, source) {
  const script = path.join(dir, 'job.js');
  fs.writeFileSync(script, source);
  return `node "${script}"`;
}

function options(configDir, extra = {}) {
  return { supervisorPath, configDir, heartbeatMs: 50, pollMs: 25, timeoutMarginSeconds: 0, ...extra };
}

function request(configDir, command, extra = {}) {
  return {
    jobId: 'demo', startedAt: new Date().toISOString(), command,
    cwd: configDir, env: process.env, timeoutSeconds: 0, label: 'Demo', trigger: { kind: 'cron' },
    ...extra,
  };
}

function closed(child) {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until(what, predicate) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('startSupervised', () => {
  test('returns a child whose pid is the job, not the supervisor, and closes with the job\'s exit code', async () => {
    const dir = tmp();
    const child = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'process.exit(3)')));
    children.push(child);

    assert.ok(child instanceof SupervisedChild);
    assert.equal(typeof child.pid, 'number');
    const status = JSON.parse(fs.readFileSync(path.join(child.runDir, 'status.json'), 'utf8'));
    assert.equal(child.pid, status.childPid, 'the sampler and the kill must see the job\'s own pid');
    assert.notEqual(child.pid, status.supervisorPid);

    const { code } = await closed(child);
    assert.equal(code, 3);
  });

  test('the output reaches the run log in the daemon\'s format, with no pipe to the daemon', async () => {
    const dir = tmp();
    const startedAt = '2026-10-18T10:00:00.123Z';
    const child = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'console.log("hello"); console.error("oops")'), { startedAt }));
    children.push(child);
    await closed(child);

    const log = fs.readFileSync(path.join(dir, 'logs', 'jobs', 'demo', 'demo-2026-10-18T10-00-00.log'), 'utf8');
    assert.match(log, /\] hello\n/);
    assert.match(log, /\] \[stderr\] oops\n/);
  });

  test('the job\'s environment, secrets included, reaches the job and is never written to disk', async () => {
    const dir = tmp();
    const secret = 'S3CRET-' + Math.random().toString(36).slice(2);
    const child = await startSupervised(
      options(dir),
      request(dir, scriptCommand(dir, 'console.log("got=" + process.env.DEMO_SECRET)'), { env: { ...process.env, DEMO_SECRET: secret } }),
    );
    children.push(child);
    await closed(child);

    const log = fs.readFileSync(path.join(dir, 'logs', 'jobs', 'demo', fs.readdirSync(path.join(dir, 'logs', 'jobs', 'demo'))[0]), 'utf8');
    assert.ok(log.includes(`got=${secret}`), 'the job did not receive its environment');
    const everyFile = fs.readdirSync(child.runDir).map((name) => fs.readFileSync(path.join(child.runDir, name), 'utf8')).join('\n');
    assert.ok(!everyFile.includes(secret), 'a secret was written to the run folder');
  });

  test('a kill request ends the job and the supervisor records why', async () => {
    const dir = tmp();
    const child = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'setInterval(() => {}, 1000)')));
    children.push(child);
    const done = closed(child);
    assert.equal(isAlive(child.pid), true);

    child.requestKill('manual');
    await done;

    const status = JSON.parse(fs.readFileSync(path.join(child.runDir, 'status.json'), 'utf8'));
    assert.equal(status.killed, true);
    assert.equal(status.killReason, 'manual');
    assert.equal(child.killed, true);
    await until('the job process to be gone', () => !isAlive(child.pid));
  });

  test('the supervisor enforces the timeout by itself when nobody else does', async () => {
    const dir = tmp();
    const child = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'setInterval(() => {}, 1000)'), { timeoutSeconds: 1 }));
    children.push(child);

    await closed(child);

    const status = JSON.parse(fs.readFileSync(path.join(child.runDir, 'status.json'), 'utf8'));
    assert.equal(status.timedOut, true);
  });

  test('the timeout given to the supervisor is later than the daemon\'s own by a margin, so the daemon acts first', async () => {
    const dir = tmp();
    const child = await startSupervised(options(dir, { timeoutMarginSeconds: 15 }), request(dir, scriptCommand(dir, 'setInterval(() => {}, 1000)'), { timeoutSeconds: 10 }));
    children.push(child);

    const spec = JSON.parse(fs.readFileSync(path.join(child.runDir, 'spec.json'), 'utf8'));
    assert.equal(spec.timeoutSeconds, 25);
    child.requestKill('test');
    await closed(child);
  });

  test('a job that cannot start closes with a failure and carries the reason', async () => {
    const dir = tmp();
    const child = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'process.exit(0)'), { cwd: path.join(dir, 'does-not-exist') }));
    children.push(child);

    assert.ok(child.startError, 'the reason it did not start must be kept');
    const { code } = await closed(child);
    assert.equal(code, 1);
  });

  test('the run folder name has millisecond resolution, so two runs in one second do not collide', async () => {
    const dir = tmp();
    const first = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'process.exit(0)'), { startedAt: '2026-10-18T10:00:00.100Z' }));
    const second = await startSupervised(options(dir), request(dir, scriptCommand(dir, 'process.exit(0)'), { startedAt: '2026-10-18T10:00:00.200Z' }));
    children.push(first, second);

    assert.notEqual(first.runDir, second.runDir);
    await Promise.all([closed(first), closed(second)]);
  });

  test('says what to check when the supervisor never reports', async () => {
    const dir = tmp();
    const notASupervisor = process.execPath;
    await assert.rejects(
      startSupervised(options(dir, { supervisorPath: notASupervisor, startupTimeoutMs: 300 }), request(dir, 'echo hi')),
      /did not report.*status\.json/s,
    );
  });
});
