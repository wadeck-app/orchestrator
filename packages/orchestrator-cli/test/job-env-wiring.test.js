'use strict';

// jobEnvironment is tested on its own in job-env.test.js. These tests check that the Scheduler and ExecManager call it
// with what they should: the daemon's environment, the job's env, its secrets and the `jobsNoColor` setting. The
// children are doubles that only record the environment they were started with.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { Registry } = require('../src/registry');
const { State } = require('../src/state');
const { Scheduler } = require('../src/scheduler');
const { SecretsManager } = require('../src/secrets');
const { ExecManager } = require('../src/exec-manager');
const { FakeTime } = require('../src/time-service');

const COLOUR_VARS = ['NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE'];
let saved;
const dirs = [];
beforeEach(() => {
  saved = Object.fromEntries(COLOUR_VARS.map((k) => [k, process.env[k]]));
  for (const k of COLOUR_VARS) { delete process.env[k]; }
});
afterEach(() => {
  for (const k of COLOUR_VARS) {
    if (saved[k] === undefined) { delete process.env[k]; } else { process.env[k] = saved[k]; }
  }
  for (const d of dirs.splice(0)) { fs.rmSync(d, { recursive: true, force: true }); }
});

function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-env-wiring-'));
  dirs.push(d);
  return d;
}

function endingChild() {
  const child = new EventEmitter();
  child.pid = undefined;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => child.emit('close', 0));
  return child;
}

/** The environment a job is started with by a Scheduler built with `scheduler` options. */
async function jobEnvOf({ job = {}, secrets = {}, scheduler = {} } = {}) {
  const dir = tmp();
  for (const [name, value] of Object.entries(secrets)) { new SecretsManager(dir).set(name, value); }
  const registry = new Registry(path.join(dir, 'registry.json'));
  registry.load();
  const j = { id: 'envjob', type: 'startup', delaySeconds: 0, command: 'node x.js', enabled: true, triggerMode: 'wait', liveness: null, ...job };
  registry.add(j);
  let seen;
  const sched = new Scheduler(registry, new State(path.join(dir, 'state.json')), {
    configDir: dir,
    time: new FakeTime(Date.now()),
    liveness: async () => false,
    spawn: (cmd, cwd, env) => { seen = env; return endingChild(); },
    ...scheduler,
  });
  await sched._fire(j);
  assert.ok(seen, 'the job was never spawned');
  return seen;
}

describe('Scheduler: the environment of a job', () => {
  test('by default an inherited FORCE_COLOR=1 / CLICOLOR_FORCE=1 become NO_COLOR=1 / FORCE_COLOR=0 and no CLICOLOR_FORCE', async () => {
    process.env.FORCE_COLOR = '1';
    process.env.CLICOLOR_FORCE = '1';

    const env = await jobEnvOf();

    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.FORCE_COLOR, '0');
    assert.equal('CLICOLOR_FORCE' in env, false);
  });

  test('jobsNoColor: false hands the job the daemon\'s colour variables untouched and adds none', async () => {
    process.env.FORCE_COLOR = '1';
    process.env.CLICOLOR_FORCE = '1';

    const env = await jobEnvOf({ scheduler: { jobsNoColor: false } });

    assert.equal(env.FORCE_COLOR, '1');
    assert.equal(env.CLICOLOR_FORCE, '1');
    assert.equal('NO_COLOR' in env, false);
  });

  test('a secret named FORCE_COLOR beats the colour default, and the job\'s env beats the daemon\'s', async () => {
    const bySecret = await jobEnvOf({ job: { secrets: ['FORCE_COLOR'] }, secrets: { FORCE_COLOR: '3' } });
    assert.equal(bySecret.FORCE_COLOR, '3');
    assert.equal(bySecret.NO_COLOR, '1');

    process.env.FORCE_COLOR = '1';
    const byEnv = await jobEnvOf({ job: { env: { FORCE_COLOR: '2', NO_COLOR: '' } } });
    assert.equal(byEnv.FORCE_COLOR, '2');
    assert.equal(byEnv.NO_COLOR, '');
  });

  test('a secret that is not stored is not invented: the job still starts with the defaults', async () => {
    const env = await jobEnvOf({ job: { secrets: ['NOT_STORED'] } });

    assert.equal('NOT_STORED' in env, false);
    assert.equal(env.NO_COLOR, '1');
  });
});

describe('ExecManager: the environment of a command', () => {
  function execEnvOf({ options = {}, env } = {}) {
    let seen;
    const manager = new ExecManager(tmp(), { publish() {} }, {
      time: new FakeTime(Date.now()),
      spawn: (bin, args, spawnOptions) => { seen = spawnOptions.env; return endingChild(); },
      ...options,
    });
    manager.fireExec('node x.js', { env });
    assert.ok(seen, 'the command was never spawned');
    return seen;
  }

  test('by default like a job: NO_COLOR=1, FORCE_COLOR=0, no CLICOLOR_FORCE', () => {
    process.env.FORCE_COLOR = '1';
    process.env.CLICOLOR_FORCE = '1';

    const env = execEnvOf();

    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.FORCE_COLOR, '0');
    assert.equal('CLICOLOR_FORCE' in env, false);
  });

  test('jobsNoColor: false keeps the daemon\'s variables and adds none', () => {
    process.env.FORCE_COLOR = '1';

    const env = execEnvOf({ options: { jobsNoColor: false } });

    assert.equal(env.FORCE_COLOR, '1');
    assert.equal('NO_COLOR' in env, false);
  });

  test('the env given to the exec wins per variable', () => {
    const env = execEnvOf({ env: { NO_COLOR: 'mine' } });

    assert.equal(env.NO_COLOR, 'mine');
    assert.equal(env.FORCE_COLOR, '0');
  });
});
