'use strict';

// Starting at boot with no login on Linux needs lingering for the user (`loginctl enable-linger`). `orch install` tries it as the
// user, then through sudo when that fails and a person can type a password; the daemon says at its start when it is missing.
// Nothing here touches the system: loginctl and sudo are doubles.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { ensureLinger, lingerAdvice } = require('../src/startup');

function fail(message, extra = {}) {
  return Object.assign(new Error(message), extra);
}

/** loginctl/sudo double. `lingering`: what `show-user` answers. `plain`/`sudo`: an Error to throw for that way, or null. */
function setup({ lingering = 'no', plain = null, sudo = null, interactive = true, platform = 'linux' } = {}) {
  const calls = [];
  const exec = (cmd, args, opts) => {
    calls.push({ cmd, args, stdio: opts?.stdio });
    if (cmd === 'loginctl' && args[0] === 'show-user') {
      return `${lingering}\n`;
    }
    if (cmd === 'loginctl' && args[0] === 'enable-linger') {
      if (plain) { throw plain; }
      return '';
    }
    if (cmd === 'sudo') {
      if (sudo) { throw sudo; }
      return '';
    }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
  return { calls, deps: { platform, exec, user: 'wade', interactive } };
}

describe('ensureLinger', () => {
  test('already lingering: nothing is run to change it', () => {
    const { deps, calls } = setup({ lingering: 'yes' });
    const r = ensureLinger(deps);
    assert.equal(r.ok, true);
    assert.match(r.detail, /already/);
    assert.ok(!calls.some((c) => c.args[0] === 'enable-linger'), JSON.stringify(calls));
  });

  test('the user is allowed to enable it for themselves: no sudo', () => {
    const { deps, calls } = setup();
    const r = ensureLinger(deps);
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [
      ['loginctl', 'show-user', 'wade', '--property=Linger', '--value'],
      ['loginctl', 'enable-linger', 'wade'],
    ]);
  });

  test('refused to the user: sudo is tried with the terminal handed over, so the password can be typed', () => {
    const { deps, calls } = setup({ plain: fail('Access denied', { stderr: 'Failed to enable linger: Access denied' }) });
    const r = ensureLinger(deps);
    assert.equal(r.ok, true);
    assert.match(r.detail, /sudo/);
    const sudoCall = calls.find((c) => c.cmd === 'sudo');
    assert.deepEqual([sudoCall.cmd, ...sudoCall.args], ['sudo', 'loginctl', 'enable-linger', 'wade']);
    assert.equal(sudoCall.stdio, 'inherit');
  });

  test('refused and nobody to type a password: no sudo, the exact command is given', () => {
    const { deps, calls } = setup({ plain: fail('Access denied'), interactive: false });
    const r = ensureLinger(deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /sudo loginctl enable-linger wade/);
    assert.ok(!calls.some((c) => c.cmd === 'sudo'), 'sudo would wait on a prompt nobody sees');
  });

  test('sudo refused: says what failed and the command to run by hand', () => {
    const { deps } = setup({ plain: fail('Access denied'), sudo: fail('exit 1') });
    const r = ensureLinger(deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /sudo loginctl enable-linger wade/);
    assert.match(r.error, /Access denied/);
  });

  test('no loginctl: says systemd is needed, without trying sudo', () => {
    const { deps, calls } = setup({ plain: fail('spawn loginctl ENOENT', { code: 'ENOENT' }) });
    const r = ensureLinger({ ...deps, exec: (cmd, args, opts) => { calls.push({ cmd }); throw fail('spawn loginctl ENOENT', { code: 'ENOENT' }); } });
    assert.equal(r.ok, false);
    assert.match(r.error, /loginctl was not found/);
    assert.ok(!calls.some((c) => c.cmd === 'sudo'));
  });

  test('not Linux: nothing to do, nothing run', () => {
    const { deps, calls } = setup({ platform: 'win32' });
    const r = ensureLinger(deps);
    assert.equal(r.ok, true);
    assert.deepEqual(calls, []);
  });
});

describe('lingerAdvice: what the daemon says at its start', () => {
  test('not Linux: nothing', () => {
    const { deps } = setup({ platform: 'darwin' });
    assert.equal(lingerAdvice({ ...deps, registered: true }), null);
  });

  test('not registered at login: says so and names the command', () => {
    const { deps } = setup();
    assert.match(lingerAdvice({ ...deps, registered: false }), /orch install/);
  });

  test('registered and lingering: nothing to say', () => {
    const { deps } = setup({ lingering: 'yes' });
    assert.equal(lingerAdvice({ ...deps, registered: true }), null);
  });

  test('registered without lingering: says the daemon starts at login only, and how to change it', () => {
    const { deps } = setup({ lingering: 'no' });
    const advice = lingerAdvice({ ...deps, registered: true });
    assert.match(advice, /only after a login/);
    assert.match(advice, /orch install/);
  });

  test('loginctl unreadable: it is said instead of assumed fine', () => {
    const { deps } = setup();
    const advice = lingerAdvice({ ...deps, registered: true, exec: () => { throw fail('boom'); } });
    assert.match(advice, /could not be read/);
    assert.match(advice, /boom/);
  });
});
