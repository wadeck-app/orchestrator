'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { jobEnvironment } = require('../src/job-env');

/*
 * A job is spawned with a pipe, so most programs would print no colour -- unless the daemon's own environment
 * forces it (FORCE_COLOR=1 is common in a shell that runs a dev tool, CLICOLOR_FORCE too). The daemon hands
 * every job NO_COLOR=1 and FORCE_COLOR=0 unless the job's own `env` says otherwise, per variable.
 */
describe('jobEnvironment', () => {
  test('sets NO_COLOR=1 and FORCE_COLOR=0 on an environment that says nothing about colour', () => {
    const env = jobEnvironment({ PATH: '/bin' }, undefined, true);
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.FORCE_COLOR, '0');
    assert.equal(env.PATH, '/bin');
  });

  test('replaces an inherited FORCE_COLOR other than 0 (chalk and supports-color put it before NO_COLOR)', () => {
    for (const forced of ['1', '2', '3', 'true', '']) {
      assert.equal(jobEnvironment({ FORCE_COLOR: forced }, undefined, true).FORCE_COLOR, '0', `FORCE_COLOR=${JSON.stringify(forced)}`);
    }
  });

  test('removes an inherited CLICOLOR_FORCE', () => {
    const env = jobEnvironment({ CLICOLOR_FORCE: '1', PATH: 'p' }, undefined, true);
    assert.equal('CLICOLOR_FORCE' in env, false);
    assert.equal(env.PATH, 'p');
  });

  test('leaves TERM and COLORTERM as they are', () => {
    const env = jobEnvironment({ TERM: 'xterm-256color', COLORTERM: 'truecolor' }, undefined, true);
    assert.equal(env.TERM, 'xterm-256color');
    assert.equal(env.COLORTERM, 'truecolor');
  });

  test('the job\'s own env wins, variable by variable', () => {
    const base = { NO_COLOR: 'x', FORCE_COLOR: '3', CLICOLOR_FORCE: '1', A: 'inherited' };
    // Defined by the job: untouched, even if it asks for colour.
    const env = jobEnvironment({ ...base, ...{ FORCE_COLOR: '1' } }, { FORCE_COLOR: '1' }, true);
    assert.equal(env.FORCE_COLOR, '1', 'the job asked for FORCE_COLOR=1');
    // Not defined by the job: the daemon's choice.
    assert.equal(env.NO_COLOR, '1');
    assert.equal('CLICOLOR_FORCE' in env, false);
    assert.equal(env.A, 'inherited');
  });

  test('a job that defines CLICOLOR_FORCE keeps it', () => {
    const env = jobEnvironment({ CLICOLOR_FORCE: '1' }, { CLICOLOR_FORCE: '1' }, true);
    assert.equal(env.CLICOLOR_FORCE, '1');
  });

  test('a job that defines NO_COLOR with another value keeps it', () => {
    const env = jobEnvironment({ NO_COLOR: 'yes' }, { NO_COLOR: 'yes' }, true);
    assert.equal(env.NO_COLOR, 'yes');
    assert.equal(env.FORCE_COLOR, '0');
  });

  test('a variable the job\'s secrets define counts as the job\'s own', () => {
    const env = jobEnvironment({ FORCE_COLOR: '1' }, undefined, true, { FORCE_COLOR: '1' });
    assert.equal(env.FORCE_COLOR, '1');
  });

  test('jobsNoColor false restores the inherited environment, untouched', () => {
    const base = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
    const env = jobEnvironment(base, undefined, false);
    assert.deepEqual(env, base);
    assert.notEqual(env, base, 'a copy, never the daemon\'s own environment object');
  });

  test('does not modify the environment it was given', () => {
    const base = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' };
    jobEnvironment(base, undefined, true);
    assert.deepEqual(base, { FORCE_COLOR: '1', CLICOLOR_FORCE: '1' });
  });

  test('on Windows variable names are case-insensitive: a job\'s no_color is its own NO_COLOR', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const env = jobEnvironment({ no_color: 'mine' }, { no_color: 'mine' }, true);
    assert.equal(env.NO_COLOR, undefined);
    assert.equal(env.no_color, 'mine');
  });
});

describe('jobEnvironment: spellings and empty values', () => {
  const spellings = (env, name) => Object.keys(env).filter((k) => k.toUpperCase() === name);

  test('an inherited force_color / Clicolor_Force in odd case: on Windows they are the same variables (replaced / removed, never two spellings); elsewhere they are other variables and stay', () => {
    const env = jobEnvironment({ force_color: '1', Clicolor_Force: '1', no_Color: 'x' }, undefined, true);

    if (process.platform === 'win32') {
      assert.deepEqual(spellings(env, 'FORCE_COLOR'), ['FORCE_COLOR']);
      assert.equal(env.FORCE_COLOR, '0');
      assert.deepEqual(spellings(env, 'CLICOLOR_FORCE'), []);
      assert.deepEqual(spellings(env, 'NO_COLOR'), ['NO_COLOR']);
      assert.equal(env.NO_COLOR, '1');
    } else {
      assert.equal(env.force_color, '1');
      assert.equal(env.FORCE_COLOR, '0');
      assert.equal(env.Clicolor_Force, '1');
      assert.equal(env.no_Color, 'x');
      assert.equal(env.NO_COLOR, '1');
    }
  });

  test('a job env that spells FORCE_COLOR in lower case keeps it, and the daemon adds no second spelling on Windows', () => {
    const env = jobEnvironment({ force_color: '2' }, { force_color: '2' }, true);

    if (process.platform === 'win32') {
      assert.deepEqual(spellings(env, 'FORCE_COLOR'), ['force_color']);
    } else {
      assert.equal(env.FORCE_COLOR, '0');
    }
    assert.equal(env.force_color, '2');
  });

  test('NO_COLOR defined as an empty string by the job stays empty (defined is defined)', () => {
    const env = jobEnvironment({ NO_COLOR: '' }, { NO_COLOR: '' }, true);

    assert.equal(env.NO_COLOR, '');
    assert.equal(env.FORCE_COLOR, '0');
  });

  test('FORCE_COLOR=0 set by the job is kept as its own, and so is CLICOLOR_FORCE=0', () => {
    const env = jobEnvironment({ FORCE_COLOR: '0', CLICOLOR_FORCE: '0' }, { FORCE_COLOR: '0', CLICOLOR_FORCE: '0' }, true);

    assert.equal(env.FORCE_COLOR, '0');
    assert.equal(env.CLICOLOR_FORCE, '0');
    assert.equal(env.NO_COLOR, '1');
  });

  test('a secret that defines NO_COLOR beats the colour default', () => {
    const env = jobEnvironment({ NO_COLOR: 'from-secret' }, undefined, true, { NO_COLOR: 'from-secret' });

    assert.equal(env.NO_COLOR, 'from-secret');
  });
});

/*
 * orch starts its own daemon with LAUNCHER_BUNDLE_OVERRIDE pointing at the daemon's bundle (cli.ts, startup.ts), and the
 * shared-cli updater adds UPDATER_PKG_NAME. A job inherited them, so a CLI run as a job (app-core-cli under the job
 * `npm run dev:all`) that finds itself through LAUNCHER_BUNDLE_OVERRIDE found orchestrator-cli instead and read its
 * build-info.json. They belong to the daemon, not to its jobs.
 */
describe('jobEnvironment and the launcher variables of the daemon', () => {
  test('a job does not inherit LAUNCHER_BUNDLE_OVERRIDE or UPDATER_PKG_NAME', () => {
    const env = jobEnvironment({ PATH: '/bin', LAUNCHER_BUNDLE_OVERRIDE: '/orch/dist/orchestrator.cjs', UPDATER_PKG_NAME: '@wadeck-app/orchestrator-cli' }, undefined, true);
    assert.equal(env.LAUNCHER_BUNDLE_OVERRIDE, undefined);
    assert.equal(env.UPDATER_PKG_NAME, undefined);
    assert.equal(env.PATH, '/bin');
  });

  test('this holds with jobsNoColor false too: it is not a colour matter', () => {
    const env = jobEnvironment({ LAUNCHER_BUNDLE_OVERRIDE: '/orch/dist/orchestrator.cjs', FORCE_COLOR: '1' }, undefined, false);
    assert.equal(env.LAUNCHER_BUNDLE_OVERRIDE, undefined);
    assert.equal(env.FORCE_COLOR, '1');
  });

  test('a job that sets LAUNCHER_BUNDLE_OVERRIDE itself keeps its own value', () => {
    // As the scheduler calls it: the base is the daemon's environment with the job's own env already laid over it.
    const env = jobEnvironment({ LAUNCHER_BUNDLE_OVERRIDE: '/mine/bundle.cjs' }, { LAUNCHER_BUNDLE_OVERRIDE: '/mine/bundle.cjs' }, true);
    assert.equal(env.LAUNCHER_BUNDLE_OVERRIDE, '/mine/bundle.cjs');
  });

  test('the job\'s secrets count as its own, like for colour', () => {
    const env = jobEnvironment({ UPDATER_PKG_NAME: 'secret-value' }, undefined, true, { UPDATER_PKG_NAME: 'secret-value' });
    assert.equal(env.UPDATER_PKG_NAME, 'secret-value');
  });
});
