'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path   = require('node:path');

const {
  buildRegValueName,
  buildWindowsCommand,
  buildMacArgs,
  buildMacPlist,
  enableStartup,
  disableStartup,
  isStartupEnabled,
} = require('../src/startup');

const FAKE_DIR = 'C:\\Users\\Test\\.config\\orchestrator';
const INDEX_JS = path.join(__dirname, '..', 'src', 'index.js');

describe('buildRegValueName', () => {
  test('includes configDir in value name', () => {
    const name = buildRegValueName(FAKE_DIR);
    assert.ok(name.includes(FAKE_DIR), `expected "${FAKE_DIR}" in "${name}"`);
    assert.ok(name.startsWith('Orchestrator ('), `expected prefix "Orchestrator ("`);
  });

  test('different configDirs produce different value names', () => {
    assert.notEqual(buildRegValueName('C:\\a'), buildRegValueName('C:\\b'));
  });
});

// Both builders now REQUIRE the Go launcher and throw without it. The node fallback these
// tests used to cover was removed deliberately: registering node + the bundle produces a daemon
// with no supervisor, so nothing would restart it after an update, and nothing said so. The
// launcher is absent on any host that is not a published target, which is what CI runs on.
const { findLauncherBinary } = require('../src/platform-binary');
const hasLauncher = findLauncherBinary() !== null;

describe('buildWindowsCommand', () => {
  test('two quoted segments, launcher then configDir', () => {
    if (!hasLauncher) {
      assert.throws(() => buildWindowsCommand(FAKE_DIR), /no launcher binary/);
      return;
    }
    const cmd = buildWindowsCommand(FAKE_DIR);
    assert.ok(cmd.includes(FAKE_DIR), 'expected configDir in the command');
    assert.match(cmd, /^"[^"]+" "[^"]+"$/, `expected exactly two quoted segments, got: ${cmd}`);
    assert.ok(!cmd.includes(process.execPath), 'must not fall back to node + bundle');
  });
});

describe('buildMacArgs', () => {
  test('exactly [launcher, configDir]', () => {
    if (!hasLauncher) {
      assert.throws(() => buildMacArgs(FAKE_DIR), /no launcher binary/);
      return;
    }
    const args = buildMacArgs(FAKE_DIR);
    assert.equal(args.length, 2, `expected [launcher, configDir], got ${JSON.stringify(args)}`);
    assert.equal(args[1], FAKE_DIR);
    assert.notEqual(args[0], process.execPath, 'must not fall back to node + bundle');
  });
});

describe('buildMacPlist', () => {
  test('contains orchestrator label', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('com.wadeck.orchestrator'), 'expected orchestrator label');
  });

  test('contains RunAtLoad true', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('<key>RunAtLoad</key>'), 'expected RunAtLoad key');
    assert.ok(plist.includes('<true/>'), 'expected true value');
  });

  test('contains ORCH_CONFIG_DIR environment variable', () => {
    const plist = buildMacPlist([process.execPath, INDEX_JS, FAKE_DIR], FAKE_DIR);
    assert.ok(plist.includes('ORCH_CONFIG_DIR'), 'expected ORCH_CONFIG_DIR in plist');
  });

  test('contains all program arguments', () => {
    const args  = [process.execPath, INDEX_JS, FAKE_DIR];
    const plist = buildMacPlist(args, FAKE_DIR);
    for (const arg of args) {
      assert.ok(plist.includes(arg.replace(/&/g, '&amp;').replace(/</g, '&lt;')),
        `expected arg "${arg}" in plist`);
    }
  });
});

// ---- macOS: the PATH written in the plist --------------------------------------------------------
//
// Everything is injected: the platform, the plist location (a temp dir), launchctl and the user's
// login shell. Nothing here runs a real shell, launchctl or touches ~/Library/LaunchAgents.
const fs = require('node:fs');
const os = require('node:os');
const {
  extractMarkedPath, sanitizeEntries, mergeMacPath, planMacPath, realShellRunner,
  SHELL_CAPTURE_TIMEOUT_MS,
} = require('../src/login-shell-path');
const { reportStartupRefresh, refreshStartupEntry } = require('../src/startup');

const HOME = '/Users/tester';
const NODE_BIN = '/opt/node/bin';
const START = '__ORCH_PATH_START__';
const END = '__ORCH_PATH_END__';
const marked = (p) => `${START}${p}${END}`;
const ok = (stdout, extra = {}) => ({ status: 0, stdout, stderr: '', ...extra });

/** A shell runner double that records every call. */
function fakeShell(result) {
  const calls = [];
  const run = (shell, args, env, timeoutMs) => {
    calls.push({ shell, args, env, timeoutMs });
    if (result instanceof Error) { throw result; }
    return typeof result === 'function' ? result(shell, args) : result;
  };
  run.calls = calls;
  return run;
}

const tmpDirs = [];
function plistDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-startup-'));
  tmpDirs.push(d);
  return d;
}
require('node:test').after(() => {
  for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true }); }
});

/** Runs the darwin branch of enableStartup against a temp plist; returns the result, the plist text and its PATH. */
function enableOnMac(runShell, macPath = {}) {
  const dir = plistDir();
  const plistPath = path.join(dir, 'LaunchAgents', 'com.wadeck.orchestrator.plist');
  const launchctl = [];
  const result = enableStartup('/cfg', {
    platform: 'darwin',
    plistPath,
    exec: (cmd, args) => { launchctl.push([cmd, ...args]); return ''; },
    validateTarget: () => null,
    programArguments: ['/launcher', '/cfg'],
    macPath: { runShell, shellEnv: '/bin/zsh', isExecutableFile: () => true, home: HOME, nodeBinDir: NODE_BIN, env: { HOME }, ...macPath },
  });
  const plist = fs.existsSync(plistPath) ? fs.readFileSync(plistPath, 'utf8') : '';
  const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
  return { result, plist, plistPath, launchctl, pathValue: m ? m[1] : null, entries: m ? m[1].split(':') : [] };
}

describe('macOS plist PATH: captured from the login shell', () => {
  test('the user\'s ~/.local/bin lands in the plist PATH, node dir first, fixed entries kept after', () => {
    const shell = fakeShell(ok(marked(`${HOME}/.local/bin:/opt/homebrew/bin:/usr/bin:/bin`)));
    const { result, entries, launchctl } = enableOnMac(shell);

    assert.equal(result.ok, true);
    assert.equal(result.warnings, undefined, 'a clean capture warns about nothing');
    assert.equal(entries[0], NODE_BIN, 'the daemon\'s own node must still win');
    assert.ok(entries.includes(`${HOME}/.local/bin`), `claude lives there: ${entries}`);
    for (const legacy of ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      assert.ok(entries.includes(legacy), `${legacy} must survive: ${entries}`);
    }
    assert.ok(entries.indexOf(`${HOME}/.local/bin`) < entries.indexOf('/usr/bin'), 'user entries come before the system ones');
    assert.equal(new Set(entries).size, entries.length, 'no duplicates');
    assert.deepEqual(launchctl.map((c) => c[0]), ['launchctl']);
  });

  test('the shell is run as login+interactive with a 5 s timeout and does not inherit the daemon PATH', () => {
    const shell = fakeShell(ok(marked('/a')));
    enableOnMac(shell, { env: { HOME, PATH: '/stale/node/bin:/usr/bin', USER: 'tester' } });

    const [call] = shell.calls;
    assert.equal(call.shell, '/bin/zsh');
    assert.deepEqual(call.args.slice(0, 3), ['-l', '-i', '-c']);
    assert.ok(call.args[3].includes(START) && call.args[3].includes(END));
    assert.equal(call.timeoutMs, SHELL_CAPTURE_TIMEOUT_MS);
    assert.equal(call.timeoutMs, 5000);
    assert.ok(!call.env.PATH.includes('/stale'), 'the previous plist PATH must not feed the next one');
    assert.equal(call.env.HOME, HOME);
    assert.equal(call.env.USER, 'tester');
  });

  test('rc-file noise around the markers cannot corrupt the PATH', () => {
    const noisy = `Welcome back!\n${START}/fake/from/echo${END}\nLast login...\n${marked('/real/one:/real/two')}\nbye\n`;
    const { entries, result } = enableOnMac(fakeShell(ok(noisy, { stderr: 'zsh: no job control in this shell' })));

    assert.ok(entries.includes('/real/one') && entries.includes('/real/two'));
    assert.ok(!entries.includes('/fake/from/echo'));
    assert.equal(result.warnings, undefined, 'stderr noise alone is not a failure');
  });

  test('a relative or empty entry is dropped (the relative one is named in a warning), absolute ones are kept', () => {
    const { entries, result } = enableOnMac(fakeShell(ok(marked('/good::relative/dir:.:/also/good:'))));

    assert.deepEqual(entries.slice(0, 3), [NODE_BIN, '/good', '/also/good']);
    assert.ok(!entries.some((e) => e === '' || e === '.' || e.startsWith('relative')), `got ${entries}`);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /relative\/dir/);
    assert.match(result.warnings[0], /\./);
  });

  test('XML-significant characters in a PATH are escaped in the plist', () => {
    const { plist, pathValue } = enableOnMac(fakeShell(ok(marked('/a&b/<c>/"d"'))));

    assert.ok(pathValue.includes('/a&amp;b/&lt;c&gt;/&quot;d&quot;'), `got ${pathValue}`);
    assert.ok(!plist.includes('/a&b/'), 'a raw & would make the plist invalid');
    assert.ok(!/<string>[^<]*<c>/.test(plist));
  });

  test('an invalid or missing $SHELL falls back to /bin/zsh and says so', () => {
    for (const shellEnv of ['relative/zsh', '/no/such/shell', undefined]) {
      const shell = fakeShell(ok(marked('/a')));
      const { result } = enableOnMac(shell, { shellEnv, isExecutableFile: (p) => p === '/bin/zsh' });

      assert.equal(shell.calls[0].shell, '/bin/zsh', `SHELL=${shellEnv}`);
      assert.equal(result.warnings.length, 1, `SHELL=${shellEnv}`);
      assert.match(result.warnings[0], /\$SHELL/);
      assert.match(result.warnings[0], /\/bin\/zsh/);
    }
  });

  test('a valid $SHELL (e.g. fish) is the one that is run', () => {
    const shell = fakeShell(ok(marked('/a')));
    const { result } = enableOnMac(shell, { shellEnv: '/opt/homebrew/bin/fish' });

    assert.equal(shell.calls[0].shell, '/opt/homebrew/bin/fish');
    assert.equal(result.warnings, undefined);
  });
});

describe('macOS plist PATH: when the capture fails', () => {
  const failures = {
    'timeout':       [fakeShell({ status: null, stdout: '', stderr: 'compinit: slow', timedOut: true }), /did not answer within 5s.*compinit: slow/],
    'non-zero exit': [fakeShell({ status: 3, stdout: '', stderr: 'zsh: bad option' }), /exited with 3.*bad option/],
    'missing shell': [fakeShell({ status: null, stdout: '', stderr: '', error: 'spawn /bin/zsh ENOENT' }), /could not be run: spawn \/bin\/zsh ENOENT/],
    'runner throws': [fakeShell(new Error('boom')), /could not be run: boom/],
    'garbage':       [fakeShell(ok('hello, no markers here')), /no PATH between the markers/],
    'half markers':  [fakeShell(ok(`${START}/a:/b`)), /no PATH between the markers/],
    'no absolute':   [fakeShell(ok(marked('rel:.::'))), /without any absolute directory/],
  };
  for (const [name, [shell, reason]] of Object.entries(failures)) {
    test(`${name}: default list (~/.local/bin, homebrew, fixed entries) AND an actionable warning`, () => {
      const { result, entries, plist } = enableOnMac(shell);

      assert.equal(result.ok, true, 'the entry is still written: a missing PATH must not disable start-at-login');
      assert.deepEqual(entries, [
        NODE_BIN, `${HOME}/.local/bin`, '/opt/homebrew/bin', '/opt/homebrew/sbin',
        '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
      ]);
      assert.ok(plist.includes('com.wadeck.orchestrator'));
      assert.equal(result.warnings.length, 1);
      assert.match(result.warnings[0], reason);
      assert.match(result.warnings[0], /orch restart/, 'the warning must say what to do');
      assert.match(result.warnings[0], /\.zshrc/);
    });
  }

  test('the warning reaches the daemon log through reportStartupRefresh', () => {
    const { result } = enableOnMac(fakeShell({ status: 1, stdout: '', stderr: 'x' }));
    const lines = [];
    reportStartupRefresh(result, (l) => lines.push(l));

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^start-at-login warning: could not read the PATH of your login shell/);
  });

  test('reportStartupRefresh keeps reporting failures, and stays silent for null', () => {
    const lines = [];
    reportStartupRefresh(null, (l) => lines.push(l));
    assert.deepEqual(lines, []);
    reportStartupRefresh({ ok: false, error: 'nope' }, (l) => lines.push(l));
    assert.deepEqual(lines, ['start-at-login refresh failed: nope']);
  });

  test('a stderr snippet is capped', () => {
    const { result } = enableOnMac(fakeShell({ status: 1, stdout: '', stderr: 'e'.repeat(5000) }));
    assert.ok(result.warnings[0].length < 1500, `warning is ${result.warnings[0].length} characters`);
  });
});

describe('macOS plist PATH: refresh on daemon start', () => {
  test('nothing is read from the shell when start-at-login is not enabled', () => {
    const shell = fakeShell(ok(marked('/a')));
    const plistPath = path.join(plistDir(), 'missing.plist');
    const r = refreshStartupEntry('/cfg', { platform: 'darwin', plistPath, macPath: { runShell: shell } });

    assert.equal(r, null);
    assert.equal(shell.calls.length, 0);
  });

  test('an enabled entry is rewritten with a freshly captured PATH (a ~/.zshrc edit applies at the next start)', () => {
    const first = enableOnMac(fakeShell(ok(marked('/old/bin'))));
    assert.ok(first.entries.includes('/old/bin'));

    const second = fakeShell(ok(marked('/new/bin')));
    const r = refreshStartupEntry('/cfg', {
      platform: 'darwin', plistPath: first.plistPath, exec: () => '', validateTarget: () => null, programArguments: ['/launcher', '/cfg'],
      macPath: { runShell: second, shellEnv: '/bin/zsh', isExecutableFile: () => true, home: HOME, nodeBinDir: NODE_BIN, env: {} },
    });

    assert.equal(r.ok, true);
    const text = fs.readFileSync(first.plistPath, 'utf8');
    assert.ok(text.includes('/new/bin') && !text.includes('/old/bin'));
  });
});

describe('Windows start-at-login is untouched', () => {
  test('the registry branch never calls the shell runner and never writes a plist', () => {
    const shell = fakeShell(ok(marked('/a')));
    const dir = plistDir();
    const plistPath = path.join(dir, 'x.plist');
    const calls = [];
    const result = enableStartup('C:\\cfg', {
      platform: 'win32', plistPath, validateTarget: () => null, windowsCommand: '"C:\\l.exe" "C:\\cfg"',
      exec: (cmd, args) => { calls.push([cmd, ...args]); return ''; },
      macPath: { runShell: shell },
    });

    assert.equal(result.ok, true);
    assert.equal(shell.calls.length, 0);
    assert.equal(fs.existsSync(plistPath), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'reg');
    assert.equal(result.warnings, undefined);
  });

  test('buildMacPlist without a PATH plan writes the historical fixed list (no shell involved)', () => {
    const plist = buildMacPlist(['/l'], '/cfg');
    const m = plist.match(/<key>PATH<\/key>\s*<string>([^<]*)<\/string>/);
    assert.deepEqual(m[1].split(':').slice(-5), ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']);
  });
});

describe('login-shell-path helpers', () => {
  test('extractMarkedPath takes the last start marker and ignores what surrounds it', () => {
    assert.equal(extractMarkedPath(`x${marked('/a:/b')}y`), '/a:/b');
    assert.equal(extractMarkedPath(`${START}old${marked('/new')}`), '/new');
    assert.equal(extractMarkedPath('nothing'), null);
    assert.equal(extractMarkedPath(`${START}/a`), null);
    assert.equal(extractMarkedPath(`${END}${START}/a`), null);
  });

  test('sanitizeEntries keeps absolute directories in order, deduplicated, and names what it refused', () => {
    const { entries, dropped } = sanitizeEntries('/a:/b:/a::rel:/c\u0007d:/x');
    assert.deepEqual(entries, ['/a', '/b', '/x']);
    assert.deepEqual(dropped, ['rel', '/c\u0007d']);
  });

  test('mergeMacPath: node dir first, user entries, then the fixed ones not already present', () => {
    assert.deepEqual(mergeMacPath('/n', ['/u', '/usr/bin', '/n']), ['/n', '/u', '/usr/bin', '/usr/local/bin', '/bin', '/usr/sbin', '/sbin']);
  });

  test('entries are capped at 100 and the cap is reported', () => {
    const many = Array.from({ length: 150 }, (_, i) => `/d${i}`).join(':');
    const plan = planMacPath({
      runShell: fakeShell(ok(marked(many))), shellEnv: '/bin/zsh', isExecutableFile: () => true, home: HOME, nodeBinDir: NODE_BIN, env: {},
    });
    assert.ok(plan.entries.includes('/d99') && !plan.entries.includes('/d100'));
    assert.ok(plan.entries.includes('/sbin'), 'the fixed entries survive the cap');
    assert.match(plan.warnings.join(' '), /150 entries/);
  });
});

describe('realShellRunner (the production runner, driven with node as a stand-in shell)', () => {
  test('captures stdout and the exit status', () => {
    const r = realShellRunner(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(4)'], process.env, 20000);
    assert.equal(r.stdout, 'hi');
    assert.equal(r.status, 4);
    assert.equal(r.timedOut, false);
  });

  test('a runaway shell is killed at the timeout and reported as timed out', () => {
    const r = realShellRunner(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], process.env, 700);
    assert.equal(r.timedOut, true);
    assert.equal(r.status, null);
  });

  test('a shell that does not exist is a phrased error, not an exception', () => {
    const r = realShellRunner(path.join(os.tmpdir(), 'definitely-not-a-shell-xyz'), [], process.env, 5000);
    assert.equal(r.status, null);
    assert.match(r.error, /ENOENT/);
  });
});

describe('enableStartup on unsupported platform', () => {
  test('returns ok:false on non-Windows non-macOS', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      // Skip: we ARE on a supported platform, can't easily test this without mocking platform
      return;
    }
    const result = enableStartup(FAKE_DIR);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes(process.platform));
  });
});
