'use strict';

// Start at login on Linux: a systemd USER unit. Nothing here touches the real system: the platform,
// the unit location (a temp dir), systemctl and the login shell are all injected. The unit text and
// the systemctl argv are what is verified; that systemd accepts them is NOT (no Linux host in CI).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  buildSystemdUnit, systemdUnitPath, systemdQuote,
  enableStartup, disableStartup, isStartupEnabled, refreshStartupEntry,
} = require('../src/startup');

const HOME = '/home/tester';
const START = '__ORCH_PATH_START__';
const END = '__ORCH_PATH_END__';
const marked = (p) => `${START}${p}${END}`;

const tmpDirs = [];
function tmp() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-systemd-'));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true }); } });

/** A systemctl double: records argv; `fail` maps "<verb>" to an error to throw; `enable` creates the wants link. */
function setup({ fail = {}, shellPath = marked('/home/tester/.local/bin:/usr/bin:/bin'), shellOk = true } = {}) {
  const dir      = tmp();
  const unitPath = path.join(dir, 'systemd', 'user', 'orchestrator.service');
  const wants    = path.join(dir, 'systemd', 'user', 'default.target.wants', 'orchestrator.service');
  const calls    = [];
  const shellCalls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    const verb = args[1];
    if (fail[verb]) { throw fail[verb]; }
    if (verb === 'enable') {
      fs.mkdirSync(path.dirname(wants), { recursive: true });
      fs.writeFileSync(wants, '');
    }
    if (verb === 'disable') { fs.rmSync(wants, { force: true }); }
    return '';
  };
  const runShell = (shell, args, env, timeoutMs) => {
    shellCalls.push({ shell, args, env, timeoutMs });
    return shellOk ? { status: 0, stdout: shellPath, stderr: '' } : { status: 1, stdout: '', stderr: 'rc broke' };
  };
  const deps = {
    platform: 'linux', unitPath, exec,
    validateTarget: () => null,
    programArguments: ['/staged/launcher', '/cfg'],
    daemonEntry: '/pkg/dist/orchestrator.cjs',
    linuxPath: { runShell, shellEnv: '/bin/bash', isExecutableFile: () => true, home: HOME, nodeBinDir: '/opt/node/bin', env: { HOME } },
  };
  return { deps, unitPath, wants, calls, shellCalls, dir };
}

const sysErr = (message, extra = {}) => Object.assign(new Error(message), extra);

describe('systemdQuote', () => {
  test('plain value is wrapped in double quotes', () => {
    assert.equal(systemdQuote('/opt/o/launcher', { exec: true }), '"/opt/o/launcher"');
  });

  test('spaces stay inside the quotes', () => {
    assert.equal(systemdQuote('/opt/my dir/launcher', { exec: true }), '"/opt/my dir/launcher"');
  });

  test('% is doubled (specifier), backslash and double quote are escaped', () => {
    assert.equal(systemdQuote('/a%h\\b"c', { exec: true }), '"/a%%h\\\\b\\"c"');
  });

  test('$ is doubled in ExecStart (variable expansion) but not in Environment', () => {
    assert.equal(systemdQuote('/a$HOME/b', { exec: true }), '"/a$$HOME/b"');
    assert.equal(systemdQuote('/a$HOME/b', { exec: false }), '"/a$HOME/b"');
  });

  test('a control character is refused, not written', () => {
    assert.throws(() => systemdQuote('/a\nb', { exec: true }), /control character/);
    assert.throws(() => systemdQuote('/a\x00b', { exec: false }), /control character/);
  });
});

describe('systemdUnitPath', () => {
  test('honours an absolute XDG_CONFIG_HOME', () => {
    assert.equal(systemdUnitPath({ XDG_CONFIG_HOME: '/xdg' }, HOME), path.join('/xdg', 'systemd', 'user', 'orchestrator.service'));
  });

  test('ignores an empty or relative XDG_CONFIG_HOME (the XDG spec says so)', () => {
    const expected = path.join(HOME, '.config', 'systemd', 'user', 'orchestrator.service');
    assert.equal(systemdUnitPath({ XDG_CONFIG_HOME: '' }, HOME), expected);
    assert.equal(systemdUnitPath({ XDG_CONFIG_HOME: 'rel/dir' }, HOME), expected);
    assert.equal(systemdUnitPath({}, HOME), expected);
  });
});

describe('buildSystemdUnit', () => {
  test('exact text', () => {
    const unit = buildSystemdUnit(['/opt/o/launcher', '/cfg'], '/cfg', ['/opt/node/bin', '/usr/bin'], '/pkg/dist/orchestrator.cjs');
    assert.equal(unit, [
      '# Written by `orch install` and rewritten at every daemon start: do not edit.',
      '[Unit]',
      'Description=Orchestrator daemon (launcher and supervisor)',
      '',
      '[Service]',
      'Type=simple',
      // The launcher supervises the daemon and restarts it itself: systemd must not add a second restarter.
      'Restart=no',
      // A stop ends the launcher, so the unit ends: only the launcher may be signalled. The default (the whole cgroup) would
      // also kill the supervisors and the jobs, which a stop must leave running.
      'KillMode=process',
      'ExecStart="/opt/o/launcher" "/cfg"',
      'Environment="PATH=/opt/node/bin:/usr/bin"',
      'Environment="ORCH_CONFIG_DIR=/cfg"',
      'Environment="LAUNCHER_BUNDLE_OVERRIDE=/pkg/dist/orchestrator.cjs"',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n'));
  });

  test('no bundle: no LAUNCHER_BUNDLE_OVERRIDE line', () => {
    const unit = buildSystemdUnit(['/l', '/cfg'], '/cfg', ['/usr/bin'], null);
    assert.ok(!unit.includes('LAUNCHER_BUNDLE_OVERRIDE'));
  });

  test('spaces, %, $ and quotes in every path are escaped', () => {
    const unit = buildSystemdUnit(['/o p/100%/l$x', '/c f/%h'], '/c f/%h', ['/n "q"/bin'], '/b$/%t.cjs');
    assert.ok(unit.includes('ExecStart="/o p/100%%/l$$x" "/c f/%%h"\n'), unit);
    assert.ok(unit.includes('Environment="PATH=/n \\"q\\"/bin"\n'), unit);
    assert.ok(unit.includes('Environment="ORCH_CONFIG_DIR=/c f/%%h"\n'), unit);
    assert.ok(unit.includes('Environment="LAUNCHER_BUNDLE_OVERRIDE=/b$/%%t.cjs"\n'), unit);
  });
});

describe('enableStartup on linux', () => {
  test('writes the unit, then reload, then enable (never --now), with the exact argv', () => {
    const { deps, unitPath, calls } = setup();
    const result = enableStartup('/cfg', deps);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', 'orchestrator.service'],
    ]);
    const unit = fs.readFileSync(unitPath, 'utf8');
    assert.ok(unit.includes('ExecStart="/staged/launcher" "/cfg"\n'));
    assert.ok(unit.includes('Environment="LAUNCHER_BUNDLE_OVERRIDE=/pkg/dist/orchestrator.cjs"\n'));
    assert.match(result.detail, /unit=written/);
    assert.match(result.detail, /enable=ok/);
    assert.match(result.detail, /enable-linger/, 'the install output says what a boot without login needs');
  });

  test('the unit PATH is the login shell PATH: node dir first, user entries, then the fixed system ones', () => {
    const { deps, unitPath, shellCalls } = setup();
    enableStartup('/cfg', deps);

    const m = fs.readFileSync(unitPath, 'utf8').match(/Environment="PATH=([^"]*)"/);
    assert.deepEqual(m[1].split(':'), ['/opt/node/bin', '/home/tester/.local/bin', '/usr/bin', '/bin', '/usr/local/bin', '/usr/sbin', '/sbin']);
    assert.equal(shellCalls.length, 1);
    assert.equal(shellCalls[0].shell, '/bin/bash');
    assert.deepEqual(shellCalls[0].args.slice(0, 3), ['-l', '-i', '-c']);
  });

  test('a failed PATH capture still enables, with a default PATH (no homebrew) and a warning naming the unit', () => {
    const { deps, unitPath } = setup({ shellOk: false });
    const result = enableStartup('/cfg', deps);

    assert.equal(result.ok, true);
    const m = fs.readFileSync(unitPath, 'utf8').match(/Environment="PATH=([^"]*)"/);
    assert.ok(m[1].includes('/home/tester/.local/bin'));
    assert.ok(!m[1].includes('homebrew'), m[1]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /unit file/);
    assert.match(result.warnings[0], /orch restart/);
    assert.ok(!/plist|zshrc/.test(result.warnings[0]), result.warnings[0]);
  });

  test('a configDir with a newline is refused before anything is written', () => {
    const { deps, unitPath, calls } = setup();
    const result = enableStartup('/cfg\n/evil', deps);
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(unitPath), false);
    assert.deepEqual(calls, []);
  });

  test('an unusable target is reported and nothing is written', () => {
    const { deps, unitPath, calls } = setup();
    const result = enableStartup('/cfg', { ...deps, validateTarget: () => 'no launcher, reinstall' });
    assert.deepEqual(result, { ok: false, error: 'no launcher, reinstall' });
    assert.equal(fs.existsSync(unitPath), false);
    assert.deepEqual(calls, []);
  });

  test('no systemctl on PATH: says systemd is required, names the unit that was written', () => {
    const { deps, unitPath } = setup({ fail: { 'daemon-reload': sysErr('spawnSync systemctl ENOENT', { code: 'ENOENT' }) } });
    const result = enableStartup('/cfg', deps);

    assert.equal(result.ok, false);
    assert.match(result.error, /systemctl was not found on PATH/);
    assert.match(result.error, /systemd/);
    assert.ok(result.error.includes(unitPath), 'the written unit must be named');
    assert.match(result.error, /orch start/, 'what to do instead');
  });

  for (const stderr of [
    'Failed to connect to bus: No medium found',
    'Failed to connect to user scope bus via local transport: $DBUS_SESSION_BUS_ADDRESS and $XDG_RUNTIME_DIR not defined',
    'System has not been booted with systemd as init system (PID 1). Can\'t operate.',
  ]) {
    test(`no user systemd session (${stderr.slice(0, 32)}...): explains lingering without running it`, () => {
      const { deps, calls, unitPath } = setup({ fail: { 'daemon-reload': sysErr('Command failed: systemctl --user daemon-reload\n' + stderr, { stderr: Buffer.from(stderr) }) } });
      const result = enableStartup('/cfg', deps);

      assert.equal(result.ok, false);
      assert.match(result.error, /no systemd user session/);
      assert.match(result.error, /loginctl enable-linger/);
      assert.ok(result.error.includes(unitPath));
      assert.ok(result.error.includes(stderr), 'the raw systemctl message is kept');
      assert.ok(!calls.some((c) => c[0] === 'loginctl'), 'privileged commands are never run');
    });
  }

  test('enable fails after the unit was written: both facts reported, with the raw message', () => {
    const msg = 'Failed to enable unit: Access denied';
    const { deps, unitPath } = setup({ fail: { enable: sysErr('Command failed\n' + msg, { stderr: msg }) } });
    const result = enableStartup('/cfg', deps);

    assert.equal(result.ok, false);
    assert.ok(result.error.includes(unitPath), 'unit written');
    assert.match(result.error, /systemctl --user enable orchestrator\.service/);
    assert.ok(result.error.includes(msg));
    assert.equal(fs.existsSync(unitPath), true);
  });

  test('unit cannot be written: says where and why', () => {
    const { deps, dir } = setup();
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a file where a directory is needed');
    const result = enableStartup('/cfg', { ...deps, unitPath: path.join(blocker, 'systemd', 'orchestrator.service') });

    assert.equal(result.ok, false);
    assert.match(result.error, /Failed to write the systemd unit/);
    assert.ok(result.error.includes(blocker));
  });

  test('an unknown platform is still unsupported, and runs nothing', () => {
    const { deps, calls } = setup();
    const result = enableStartup('/cfg', { ...deps, platform: 'freebsd' });
    assert.deepEqual(result, { ok: false, error: 'Unsupported platform: freebsd' });
    assert.deepEqual(calls, []);
  });
});

describe('isStartupEnabled on linux', () => {
  test('false before anything is installed', () => {
    const { deps } = setup();
    assert.equal(isStartupEnabled('/cfg', deps), false);
  });

  test('true once enabled (unit written AND default.target.wants link present)', () => {
    const { deps } = setup();
    enableStartup('/cfg', deps);
    assert.equal(isStartupEnabled('/cfg', deps), true);
  });

  test('false when the unit exists but was never enabled', () => {
    const { deps, unitPath } = setup();
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, buildSystemdUnit(['/l', '/cfg'], '/cfg', ['/usr/bin'], null));
    assert.equal(isStartupEnabled('/cfg', deps), false);
  });

  test('false when the link exists but the unit file is gone', () => {
    const { deps, unitPath } = setup();
    enableStartup('/cfg', deps);
    fs.rmSync(unitPath);
    assert.equal(isStartupEnabled('/cfg', deps), false);
  });

  test('false for another configDir: the unit is global, a second instance must not take it over', () => {
    const { deps } = setup();
    enableStartup('/cfg', deps);
    assert.equal(isStartupEnabled('/other', deps), false);
  });

  test('does not need systemctl or a session bus (it only reads the filesystem)', () => {
    const { deps } = setup();
    enableStartup('/cfg', deps);
    const exec = () => { throw new Error('must not be called'); };
    assert.equal(isStartupEnabled('/cfg', { ...deps, exec }), true);
  });
});

describe('disableStartup on linux', () => {
  test('disable, remove the unit, daemon-reload: exact argv, in that order', () => {
    const { deps, unitPath, calls } = setup();
    enableStartup('/cfg', deps);
    calls.length = 0;

    const result = disableStartup('/cfg', deps);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(calls, [
      ['systemctl', '--user', 'disable', 'orchestrator.service'],
      ['systemctl', '--user', 'daemon-reload'],
    ]);
    assert.equal(fs.existsSync(unitPath), false);
    assert.equal(isStartupEnabled('/cfg', deps), false);
  });

  test('never installed: ok, nothing run', () => {
    const { deps, calls } = setup();
    const result = disableStartup('/cfg', deps);
    assert.equal(result.ok, true);
    assert.match(result.detail, /already/);
    assert.deepEqual(calls, []);
  });

  test('systemctl disable fails: the unit is still removed (so it is off) and the failure is reported', () => {
    const msg = 'Failed to connect to bus: No medium found';
    const { deps, unitPath } = setup();
    enableStartup('/cfg', deps);
    const result = disableStartup('/cfg', {
      ...deps,
      exec: (cmd, args) => { if (args[1] === 'disable') { throw sysErr('x', { stderr: msg }); } return ''; },
    });

    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(unitPath), false);
    assert.ok(result.error.includes(msg));
    assert.match(result.error, /systemctl --user disable orchestrator\.service/);
    assert.equal(isStartupEnabled('/cfg', deps), false, 'with the unit gone it must read as disabled');
  });

  test('no systemctl: unit removed, failure explicit', () => {
    const { deps, unitPath } = setup();
    enableStartup('/cfg', deps);
    const result = disableStartup('/cfg', {
      ...deps,
      exec: () => { throw sysErr('spawnSync systemctl ENOENT', { code: 'ENOENT' }); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /systemctl was not found on PATH/);
    assert.equal(fs.existsSync(unitPath), false);
  });
});

describe('refreshStartupEntry on linux', () => {
  test('nothing is read, written or run when start-at-login is not enabled', () => {
    const { deps, shellCalls, calls, unitPath } = setup();
    assert.equal(refreshStartupEntry('/cfg', deps), null);
    assert.equal(shellCalls.length, 0);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(unitPath), false);
  });

  test('an enabled unit is rewritten with the current launcher path', () => {
    const { deps, unitPath } = setup();
    enableStartup('/cfg', deps);
    const r = refreshStartupEntry('/cfg', { ...deps, programArguments: ['/staged/NEW/launcher', '/cfg'] });

    assert.equal(r.ok, true);
    const unit = fs.readFileSync(unitPath, 'utf8');
    assert.ok(unit.includes('ExecStart="/staged/NEW/launcher" "/cfg"'));
    assert.ok(!unit.includes('/staged/launcher'));
  });
});
