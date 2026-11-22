'use strict';

// Start at login through the Node watchdog (phase B): the entry names `node <configDir>/orchestrator-start.cjs <configDir> <hint>`
// (a hidden wscript.exe script on Windows), and the bootstrap finds the CURRENT install's dist/orchestrator-watchdog.cjs at every
// login. Nothing here touches the real registry, LaunchAgents, systemd or ~/.config: the platform, the registry (a Map behind an
// injected exec), systemctl, the login shell and every directory are injected or temporary.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');

const {
  buildSystemdUnit, buildMacPlist, systemdQuote, enableStartup, disableStartup, isStartupEnabled,
  inspectStartupEntry, repairStartupEntry, refreshStartupEntry,
} = require('../src/startup');
const {
  BOOTSTRAP_FILE, START_VBS_FILE, BOOTSTRAP_SOURCE, bootstrapArgs, buildStartVbs, encodeVbs, decodeVbs, buildRunValue, parseRunValue,
  parseStartVbs, writeIfChanged, removeStartFiles,
} = require('../src/start-bootstrap');
const { runStartupCheck } = require('../src/startup-check');

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const tmpDirs = [];
function tmp(prefix = 'orch-wdentry-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
after(() => { for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } });

/** A fake install: <root>/dist/orchestrator-watchdog.cjs and orchestrator.cjs, both real files. */
function fakeInstall() {
  const dist = path.join(tmp(), 'node_modules', '@wadeck-app', 'orchestrator-cli', 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const watchdog = path.join(dist, 'orchestrator-watchdog.cjs');
  fs.writeFileSync(watchdog, '// fake watchdog\n');
  fs.writeFileSync(path.join(dist, 'orchestrator.cjs'), '// fake daemon\n');
  return { dist, watchdog, daemon: path.join(dist, 'orchestrator.cjs') };
}

/** The bootstrap as the login runs it: the real text, written to a file and required (it only runs when it is the main module). */
function loadBootstrap() {
  const file = path.join(tmp(), BOOTSTRAP_FILE);
  fs.writeFileSync(file, BOOTSTRAP_SOURCE);
  return require(file);
}

const distOf = (modulesDir) => path.join(modulesDir, '@wadeck-app', 'orchestrator-cli', 'dist');

// ---------------------------------------------------------------------------------------------------------------------------
describe('bootstrap: which watchdog it runs (the order of the Go launcher\'s ResolveNodeScript)', () => {
  const { resolveWatchdog } = loadBootstrap();
  const WD = 'orchestrator-watchdog.cjs';
  const resolve = (over) => {
    const files = new Set(over.files ?? []);
    return resolveWatchdog({ env: {}, execPath: path.join(path.sep, 'opt', 'node', 'bin', 'node'), platform: 'linux', hint: '', ...over, isFile: (f) => files.has(f) });
  };

  test('LAUNCHER_BUNDLE_OVERRIDE wins over every other place, and is never second-guessed', () => {
    const nodeModules = path.join(path.sep, 'opt', 'node', 'lib', 'node_modules');
    const override = path.join(path.sep, 'checkout', 'dist', 'orchestrator.cjs');
    const r = resolve({
      env: { LAUNCHER_BUNDLE_OVERRIDE: override },
      files: [path.join(path.dirname(override), WD), path.join(distOf(nodeModules), WD)],
    });
    assert.equal(r.file, path.join(path.dirname(override), WD));
    assert.equal(r.via, 'LAUNCHER_BUNDLE_OVERRIDE');
    const missing = resolve({ env: { LAUNCHER_BUNDLE_OVERRIDE: override }, files: [path.join(distOf(nodeModules), WD)] });
    assert.equal(missing.file, null);
    assert.match(missing.problem, /LAUNCHER_BUNDLE_OVERRIDE points at .*no orchestrator-watchdog\.cjs next to it\. Unset it/);
  });

  test('Windows installer layout: node_modules next to node.exe', () => {
    const nodeDir = path.join(path.sep, 'Program Files', 'nodejs');
    const want = path.join(distOf(path.join(nodeDir, 'node_modules')), WD);
    const r = resolve({ platform: 'win32', execPath: path.join(nodeDir, 'node.exe'), files: [want] });
    assert.equal(r.file, want);
    assert.match(r.via, /node_modules next to/);
  });

  test('global prefix OUTSIDE node\'s folder (%APPDATA%\\npm, the Windows default) is found', () => {
    const appData = path.join(path.sep, 'Users', 'me', 'AppData', 'Roaming');
    const want = path.join(distOf(path.join(appData, 'npm', 'node_modules')), WD);
    const r = resolve({ platform: 'win32', execPath: path.join(path.sep, 'Program Files', 'nodejs', 'node.exe'), env: { APPDATA: appData }, files: [want] });
    assert.equal(r.file, want);
    assert.match(r.via, /APPDATA/);
  });

  test('a custom npm prefix of the environment is found (unix lib/node_modules, Windows node_modules)', () => {
    const prefix = path.join(path.sep, 'home', 'me', '.npm-global');
    const unix = path.join(distOf(path.join(prefix, 'lib', 'node_modules')), WD);
    assert.equal(resolve({ env: { npm_config_prefix: prefix }, files: [unix] }).file, unix);
    const win = path.join(distOf(path.join(prefix, 'node_modules')), WD);
    assert.equal(resolve({ platform: 'win32', env: { NPM_CONFIG_PREFIX: prefix }, files: [win] }).file, win);
  });

  test('nvm-style layout: the modules of the node that runs, in ../lib/node_modules, follow the node in use', () => {
    const v22 = path.join(path.sep, 'home', 'me', '.nvm', 'versions', 'node', 'v22');
    const v20 = path.join(path.sep, 'home', 'me', '.nvm', 'versions', 'node', 'v20');
    const in22 = path.join(distOf(path.join(v22, 'lib', 'node_modules')), WD);
    const in20 = path.join(distOf(path.join(v20, 'lib', 'node_modules')), WD);
    // After `nvm use 22` the login runs node 22: the entry's hint still names the version it was written under (20).
    const r = resolve({ execPath: path.join(v22, 'bin', 'node'), hint: in20, files: [in22, in20] });
    assert.equal(r.file, in22, 'a stale hint must not win over the install of the node in use');
  });

  test('the install seen when the entry was written is the LAST resort (a prefix nothing else can know)', () => {
    const hint = path.join(distOf(path.join(path.sep, 'weird', 'prefix', 'node_modules')), WD);
    const r = resolve({ hint, files: [hint] });
    assert.equal(r.file, hint);
    assert.match(r.via, /install seen when the entry was written/);
  });

  test('a package with no watchdog (an older version) is named as such, with the command to run', () => {
    const nodeModules = path.join(path.sep, 'opt', 'node', 'lib', 'node_modules');
    const r = resolve({ files: [path.join(distOf(nodeModules), 'orchestrator.cjs')] });
    assert.equal(r.file, null);
    assert.match(r.problem, /has no orchestrator-watchdog\.cjs \(an older version\)/);
    assert.match(r.problem, /npm install -g @wadeck-app\/orchestrator-cli/);
  });

  test('nothing found: every folder looked in is listed, with the two commands that fix it', () => {
    const r = resolve({ hint: path.join(path.sep, 'gone', WD) });
    assert.equal(r.file, null);
    assert.match(r.problem, /cannot find orchestrator-watchdog\.cjs of @wadeck-app\/orchestrator-cli \(looked in: .*node_modules.*gone/);
    assert.match(r.problem, /npm install -g @wadeck-app\/orchestrator-cli, then run: orch install/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('bootstrap: run() logs what it did, hands over to the watchdog in-process', () => {
  const { run } = loadBootstrap();
  function io(over = {}) {
    const state = { appended: [], stderr: [], loaded: [], argv: null, mkdirs: [] };
    const files = new Set(over.files ?? []);
    return {
      state,
      io: {
        env: {}, execPath: path.join(path.sep, 'n', 'node'), platform: 'linux',
        isFile: (f) => files.has(f),
        now: () => new Date(2026, 10, 22, 9, 5, 7),
        mkdirp: (d) => { state.mkdirs.push(d); if (over.mkdirFails) { throw new Error('read-only'); } },
        append: (f, t) => { state.appended.push([f, t]); },
        tmpdir: () => path.join(path.sep, 'tmpdir'),
        stderr: (t) => { state.stderr.push(t); },
        load: (f) => { state.loaded.push(f); if (over.loadFails) { throw new Error('SyntaxError: boom'); } },
        setArgv: (a) => { state.argv = a; },
        ...over.io,
      },
    };
  }
  const cfg = path.join(path.sep, 'cfg dir é');

  test('found: argv is replaced by [node, watchdog, configDir] (the hint is not passed on), one INFO line, returns null', () => {
    const hint = path.join(path.sep, 'h', 'dist', 'orchestrator-watchdog.cjs');
    const { io: deps, state } = io({ files: [hint] });
    assert.equal(run(['node', 'boot', cfg, hint], deps), null);
    assert.deepEqual(state.argv, [deps.execPath, hint, cfg]);
    assert.deepEqual(state.loaded, [hint]);
    assert.equal(state.appended.length, 1);
    assert.equal(state.appended[0][0], path.join(cfg, 'logs', '2026-11-22-launcher.log'));
    assert.match(state.appended[0][1], /^\[09:05:07\] \[ INFO\] \[launcher\] start at login: running .* \(found via the install seen/);
  });

  test('not found: ERROR line in the launcher log (same file and format as the watchdog), exit code 1, no load', () => {
    const { io: deps, state } = io();
    assert.equal(run(['node', 'boot', cfg], deps), 1);
    assert.deepEqual(state.loaded, []);
    assert.match(state.appended[0][1], /^\[09:05:07\] \[ERROR\] \[launcher\] start at login: cannot find orchestrator-watchdog\.cjs .*orch install\n$/);
    assert.equal(state.stderr.length, 1);
  });

  test('a watchdog that cannot be loaded is an ERROR with the reason, exit code 1', () => {
    const hint = path.join(path.sep, 'h', 'orchestrator-watchdog.cjs');
    const { io: deps, state } = io({ files: [hint], loadFails: true });
    assert.equal(run(['node', 'boot', cfg, hint], deps), 1);
    assert.match(state.appended[1][1], /\[ERROR\] .* could not be loaded \(SyntaxError: boom\)\. Re-install with: npm install -g/);
  });

  test('a log dir that cannot be written falls back to the tmp file and stderr, never to silence', () => {
    const { io: deps, state } = io({ mkdirFails: true });
    assert.equal(run(['node', 'boot', cfg], deps), 1);
    assert.equal(state.appended[0][0], path.join(path.sep, 'tmpdir', 'orchestrator-launcher-fallback.log'));
    assert.match(state.appended[0][1], /cannot write .*cfg dir é \(read-only\)/);
    assert.equal(state.stderr.length, 1);
  });

  test('no config dir: exit code 2 with the usage, nothing logged anywhere', () => {
    const { io: deps, state } = io();
    assert.equal(run(['node', 'boot'], deps), 2);
    assert.match(state.stderr[0], /no config dir given.*orch install/);
    assert.deepEqual(state.appended, []);
  });

  test('the bootstrap text is plain CJS with no require beyond fs, os and path', () => {
    const required = [...BOOTSTRAP_SOURCE.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(required)].sort(), ['fs', 'os', 'path']);
    assert.ok(BOOTSTRAP_SOURCE.startsWith('// orchestrator-start v1'), 'versioned by its first line');
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('Windows hidden-start script and Run value', () => {
  const configDir = 'C:\\Users\\Zoë Müller\\.config\\orchestrator';
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const hint = 'C:\\Users\\Zoë Müller\\AppData\\Roaming\\npm\\node_modules\\@wadeck-app\\orchestrator-cli\\dist\\orchestrator-watchdog.cjs';
  const args = [node, `${configDir}\\${BOOTSTRAP_FILE}`, configDir, hint];

  test('window style 0, no wait, no shell; paths with spaces and non-ASCII characters survive the round trip', () => {
    const vbs = buildStartVbs(args, configDir);
    assert.match(vbs, /^oShell\.Run ".*", 0, False\r?$/m);
    assert.ok(!/cmd(\.exe)?\s+\/c|ComSpec/i.test(vbs), 'no shell between wscript and node');
    assert.ok(vbs.includes('\r\n'), 'CRLF line ends');
    assert.deepEqual(parseStartVbs(vbs), args);
    assert.match(vbs, /""C:\\Program Files\\nodejs\\node\.exe"" ""C:\\Users\\Zoë Müller/);
  });

  test('a failed start is written to the launcher log (same name and line format), not shown as a modal dialog', () => {
    const vbs = buildStartVbs(args, configDir);
    assert.match(vbs, /On Error Resume Next\r\noShell\.Run /);
    assert.ok(vbs.includes(`logDir = "${configDir}\\logs"`));
    assert.ok(vbs.includes('-launcher.log"'));
    assert.match(vbs, /\[ERROR\] \[launcher\] start at login: wscript could not start node .*run orch install/);
  });

  test('written as UTF-16LE with a byte order mark: the only encoding wscript reads non-ASCII paths in', () => {
    const buf = encodeVbs(buildStartVbs(args, configDir));
    assert.deepEqual([...buf.subarray(0, 2)], [0xff, 0xfe]);
    assert.equal(decodeVbs(buf), buildStartVbs(args, configDir));
    assert.throws(() => decodeVbs(Buffer.from(buildStartVbs(args, configDir), 'utf8')), /no UTF-16 byte order mark/);
  });

  test('the Run value is wscript.exe //nologo "<vbs>": nothing else, so it works pasted into cmd.exe', () => {
    const value = buildRunValue(`${configDir}\\${START_VBS_FILE}`);
    assert.equal(value, `wscript.exe //nologo "${configDir}\\orchestrator-start.vbs"`);
    assert.equal(parseRunValue(value), `${configDir}\\orchestrator-start.vbs`);
    assert.equal(parseRunValue('"C:\\x\\orchestrator.exe" "C:\\cfg"'), null, 'the Go launcher\'s value is not ours');
  });

  test('a config dir ending in a backslash does not escape the closing quote', () => {
    const dir = 'C:\\cfg dir\\';
    const a = [node, `${dir}${BOOTSTRAP_FILE}`, dir];
    const vbs = buildStartVbs(a, dir);
    assert.ok(vbs.includes('""C:\\cfg dir\\\\""'), vbs);
    assert.deepEqual(parseStartVbs(vbs), a);
  });

  test('a double quote or a control character in a path is refused, not escaped', () => {
    assert.throws(() => buildStartVbs([node, 'C:\\a"b', 'C:\\c'], 'C:\\c'), /double quote or a control character/);
    assert.throws(() => buildStartVbs([node, 'C:\\a\nb', 'C:\\c'], 'C:\\c'), /control character/);
  });

  test('bootstrapArgs: node, bootstrap in the config dir, config dir, then the install seen now', () => {
    assert.deepEqual(bootstrapArgs({ node: '/n', configDir: '/c', hint: '/h' }), ['/n', path.join('/c', BOOTSTRAP_FILE), '/c', '/h']);
    assert.deepEqual(bootstrapArgs({ node: '/n', configDir: '/c', hint: null }), ['/n', path.join('/c', BOOTSTRAP_FILE), '/c']);
  });

  test('writeIfChanged writes once and then leaves the file alone; removeStartFiles names what it removed', () => {
    const dir = tmp();
    const file = path.join(dir, BOOTSTRAP_FILE);
    assert.equal(writeIfChanged(file, BOOTSTRAP_SOURCE), 'written');
    assert.equal(writeIfChanged(file, BOOTSTRAP_SOURCE), 'unchanged');
    fs.writeFileSync(file, '// edited');
    assert.equal(writeIfChanged(file, BOOTSTRAP_SOURCE), 'written');
    assert.equal(fs.readFileSync(file, 'utf8'), BOOTSTRAP_SOURCE);
    assert.deepEqual(removeStartFiles(dir), [BOOTSTRAP_FILE]);
    assert.deepEqual(removeStartFiles(dir), []);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
/** A registry behind an injected exec: add, query and delete of one value. */
function fakeReg() {
  const store = new Map();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    assert.equal(cmd, 'reg');
    const [verb, key, , name] = args;
    assert.equal(key, REG_KEY);
    if (verb === 'add') { store.set(name, args[args.indexOf('/d') + 1]); return ''; }
    if (verb === 'delete') { store.delete(name); return ''; }
    if (verb === 'query') {
      if (!store.has(name)) { throw Object.assign(new Error('not found'), { status: 1 }); }
      return `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ${name}    REG_SZ    ${store.get(name)}\r\n`;
    }
    throw new Error(`unexpected reg verb ${verb}`);
  };
  return { store, calls, exec };
}

function winSetup(over = {}) {
  const install = fakeInstall();
  const configDir = path.join(tmp(), 'cfg dir é');
  const reg = fakeReg();
  const deps = { platform: 'win32', exec: reg.exec, watchdogEntry: install.watchdog, nodePath: process.execPath, nodeBinDir: path.dirname(process.execPath), ...over };
  return { install, configDir, reg, deps, valueName: `Orchestrator (${configDir})` };
}

describe('enableStartup, Windows: the Run value starts the hidden script, which starts the bootstrap', () => {
  test('the registry value is exactly `wscript.exe //nologo "<configDir>\\orchestrator-start.vbs"` and both files exist before it', () => {
    const { install, configDir, reg, deps, valueName } = winSetup();
    const r = enableStartup(configDir, deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    const vbsPath = path.join(configDir, START_VBS_FILE);
    assert.equal(reg.store.get(valueName), `wscript.exe //nologo "${vbsPath}"`);
    assert.deepEqual(reg.calls[0].slice(0, 7), ['reg', 'add', REG_KEY, '/v', valueName, '/t', 'REG_SZ']);
    assert.equal(fs.readFileSync(path.join(configDir, BOOTSTRAP_FILE), 'utf8'), BOOTSTRAP_SOURCE);
    assert.deepEqual(parseStartVbs(decodeVbs(fs.readFileSync(vbsPath))), [process.execPath, path.join(configDir, BOOTSTRAP_FILE), configDir, install.watchdog]);
    assert.match(r.detail, /entry=watchdog/);
  });

  test('the files live in the config dir, never inside the npm package folder', () => {
    const { install, configDir, deps } = winSetup();
    enableStartup(configDir, deps);
    assert.deepEqual(fs.readdirSync(install.dist).sort(), ['orchestrator-watchdog.cjs', 'orchestrator.cjs']);
    assert.ok(fs.existsSync(path.join(configDir, START_VBS_FILE)));
  });

  test('no staged launcher and no node_modules junction for the watchdog entry (the Go fallback keeps them)', () => {
    const { configDir, deps } = winSetup();
    enableStartup(configDir, deps);
    assert.ok(!fs.existsSync(path.join(configDir, 'bin')), 'nothing is staged for the watchdog');
  });

  test('a node path with spaces is baked in quotes', () => {
    const { configDir, reg, deps } = winSetup({ nodePath: 'C:\\Program Files\\nodejs\\node.exe' });
    enableStartup(configDir, deps);
    const vbs = decodeVbs(fs.readFileSync(path.join(configDir, START_VBS_FILE)));
    assert.ok(vbs.includes('""C:\\Program Files\\nodejs\\node.exe""'), vbs);
    assert.ok(![...reg.store.values()][0].includes('Program Files'), 'the Run value itself never carries the node path');
  });

  test('a bootstrap or script changed on disk is rewritten by the next enable (daemon start)', () => {
    const { configDir, deps } = winSetup();
    enableStartup(configDir, deps);
    fs.writeFileSync(path.join(configDir, BOOTSTRAP_FILE), '// old v0');
    fs.writeFileSync(path.join(configDir, START_VBS_FILE), 'garbage');
    assert.equal(refreshStartupEntry(configDir, deps).ok, true);
    assert.equal(fs.readFileSync(path.join(configDir, BOOTSTRAP_FILE), 'utf8'), BOOTSTRAP_SOURCE);
    assert.equal(inspectStartupEntry(configDir, deps).state, 'ok');
  });

  test('an install with no watchdog bundle and a forced watchdog entry is refused, naming the file and the fix', () => {
    const { configDir, deps } = winSetup({ entryKind: 'watchdog', watchdogEntry: null });
    const r = enableStartup(configDir, deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /dist\/orchestrator-watchdog\.cjs was not found.*npm install -g @wadeck-app\/orchestrator-cli/);
  });

  test('an unwritable config dir is reported with the path, before the registry is touched', () => {
    const { reg, deps } = winSetup();
    const blocker = path.join(tmp(), 'file');
    fs.writeFileSync(blocker, '');
    const r = enableStartup(path.join(blocker, 'cfg'), deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /Failed to write the start-at-login files in .*cfg/);
    assert.equal(reg.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
const HOME = '/home/tester';
// A directory that holds a file named node: what an entry's PATH check looks for on a POSIX target, whatever host runs the test.
// Forward slashes: the POSIX entry's paths are read back with POSIX rules, also on a Windows host.
const NODE_BIN = (() => { const d = tmp('orch-fakenode-'); fs.writeFileSync(path.join(d, 'node'), ''); return d.split(path.sep).join('/'); })();
const shell = { runShell: () => ({ status: 0, stdout: '__ORCH_PATH_START__/home/tester/.local/bin:/usr/bin__ORCH_PATH_END__', stderr: '' }), shellEnv: '/bin/bash', isExecutableFile: () => true, home: HOME, nodeBinDir: NODE_BIN, env: { HOME } };

function linuxSetup(over = {}) {
  const install = fakeInstall();
  const dir = tmp();
  const configDir = path.join(dir, 'cfg dir é');
  const unitPath = path.join(dir, 'systemd', 'user', 'orchestrator.service');
  const wants = path.join(dir, 'systemd', 'user', 'default.target.wants', 'orchestrator.service');
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === 'enable') { fs.mkdirSync(path.dirname(wants), { recursive: true }); fs.writeFileSync(wants, ''); }
    if (args[1] === 'disable') { fs.rmSync(wants, { force: true }); }
    return '';
  };
  const deps = { platform: 'linux', unitPath, exec, linuxPath: shell, watchdogEntry: install.watchdog, nodePath: `${NODE_BIN}/node`, nodeBinDir: NODE_BIN, ...over };
  return { install, configDir, unitPath, wants, calls, deps };
}

describe('enableStartup, Linux: ExecStart is node, the bootstrap and the config dir', () => {
  test('ExecStart, Restart=no, KillMode=process kept; no fixed LAUNCHER_BUNDLE_OVERRIDE', () => {
    const { install, configDir, unitPath, deps } = linuxSetup({ nodePath: '/opt/node v22/bin/node' });
    const r = enableStartup(configDir, deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    const unit = fs.readFileSync(unitPath, 'utf8');
    const words = ['/opt/node v22/bin/node', path.join(configDir, BOOTSTRAP_FILE), configDir, install.watchdog].map((a) => systemdQuote(a, { exec: true }));
    assert.ok(unit.includes(`ExecStart=${words.join(' ')}\n`), unit);
    assert.match(unit, /^Restart=no$/m);
    assert.match(unit, /^KillMode=process$/m);
    assert.match(unit, /^WantedBy=default\.target$/m);
    assert.ok(!unit.includes('LAUNCHER_BUNDLE_OVERRIDE'), 'a fixed bundle would outlive an nvm use');
    assert.ok(unit.includes(`Environment=${systemdQuote(`ORCH_CONFIG_DIR=${configDir}`, { exec: false })}\n`));
    assert.match(unit, /^Environment="PATH=/m);
    assert.equal(fs.readFileSync(path.join(configDir, BOOTSTRAP_FILE), 'utf8'), BOOTSTRAP_SOURCE);
    assert.ok(!fs.existsSync(path.join(configDir, START_VBS_FILE)), 'the VBS is Windows only');
  });

  test('daemon-reload then enable (never --now) as before; the entry is enabled for this config dir', () => {
    const { configDir, calls, deps } = linuxSetup();
    enableStartup(configDir, deps);
    assert.deepEqual(calls, [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', 'orchestrator.service']]);
    assert.equal(isStartupEnabled(configDir, deps), true);
  });

  test('no watchdog in this install and a forced watchdog entry: an error naming the file, no unit written', () => {
    const { configDir, unitPath, deps } = linuxSetup({ entryKind: 'watchdog', watchdogEntry: null });
    const r = enableStartup(configDir, deps);
    assert.equal(r.ok, false);
    assert.match(r.error, /orchestrator-watchdog\.cjs was not found/);
    assert.ok(!fs.existsSync(unitPath));
  });

  test('no watchdog and no seam: the Go launcher is the fallback, with a warning, or an error that says the launcher is missing', () => {
    const { configDir, deps } = linuxSetup({ watchdogEntry: null, validateTarget: () => null });
    const r = enableStartup(configDir, deps);
    // The Go launcher binary exists on a developer machine and not on CI: both outcomes name the reason.
    assert.ok(r.ok ? (r.warnings ?? []).some((w) => /no dist\/orchestrator-watchdog\.cjs.*Go launcher \(fallback\)/.test(w)) : /no launcher binary/.test(r.error), JSON.stringify(r));
  });
});

describe('enableStartup, macOS: the LaunchAgent runs node, the bootstrap and the config dir', () => {
  test('ProgramArguments, RunAtLoad, PATH kept; no KeepAlive and no fixed LAUNCHER_BUNDLE_OVERRIDE', () => {
    const install = fakeInstall();
    const dir = tmp();
    const configDir = path.join(dir, 'cfg & é');
    const plistPath = path.join(dir, 'LaunchAgents', 'com.wadeck.orchestrator.plist');
    const calls = [];
    const r = enableStartup(configDir, {
      platform: 'darwin', plistPath, exec: (c, a) => { calls.push([c, ...a]); return ''; }, macPath: shell,
      watchdogEntry: install.watchdog, nodePath: '/Users/me/.nvm/versions/node/v22/bin/node',
    });
    assert.equal(r.ok, true, JSON.stringify(r));
    const plist = fs.readFileSync(plistPath, 'utf8');
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)[1];
    assert.deepEqual([...array.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]),
      ['/Users/me/.nvm/versions/node/v22/bin/node', path.join(configDir, BOOTSTRAP_FILE), configDir, install.watchdog].map(esc));
    assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
    assert.match(plist, /<key>PATH<\/key>/);
    assert.ok(!plist.includes('KeepAlive'));
    assert.ok(!plist.includes('LAUNCHER_BUNDLE_OVERRIDE'));
    assert.equal(fs.readFileSync(path.join(configDir, BOOTSTRAP_FILE), 'utf8'), BOOTSTRAP_SOURCE);
    assert.equal(isStartupEnabled(configDir, { platform: 'darwin', plistPath }), true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('inspectStartupEntry: an entry for the watchdog', () => {
  const win = () => { const s = winSetup(); assert.equal(enableStartup(s.configDir, s.deps).ok, true); return s; };

  test('a fresh Windows entry is ok', () => {
    const { configDir, deps } = win();
    assert.deepEqual(inspectStartupEntry(configDir, deps), { state: 'ok', problems: [] });
  });

  test('a missing hidden script is broken, with the path and the command to run', () => {
    const { configDir, deps } = win();
    fs.rmSync(path.join(configDir, START_VBS_FILE));
    const r = inspectStartupEntry(configDir, deps);
    assert.equal(r.state, 'broken');
    assert.match(r.problems.join(), /start-at-login script .*orchestrator-start\.vbs cannot be read/);
  });

  test('a damaged hidden script (no byte order mark, or no Run line) is broken', () => {
    const { configDir, deps } = win();
    const vbs = path.join(configDir, START_VBS_FILE);
    fs.writeFileSync(vbs, 'WScript.Echo "x"');
    assert.match(inspectStartupEntry(configDir, deps).problems.join(), /byte order mark/);
    fs.writeFileSync(vbs, encodeVbs("' empty\r\n"));
    assert.match(inspectStartupEntry(configDir, deps).problems.join(), /does not start anything \(damaged\): run orch install/);
  });

  test('a hidden script edited by hand (not the text of this version) is broken', () => {
    const { configDir, deps } = win();
    const vbs = path.join(configDir, START_VBS_FILE);
    fs.writeFileSync(vbs, encodeVbs(`${decodeVbs(fs.readFileSync(vbs))}' tweak\r\n`));
    assert.match(inspectStartupEntry(configDir, deps).problems.join(), /is not the one of this version \(damaged or edited\)/);
  });

  test('a missing or edited bootstrap is broken', () => {
    const { configDir, deps } = win();
    const boot = path.join(configDir, BOOTSTRAP_FILE);
    fs.writeFileSync(boot, '// edited');
    assert.match(inspectStartupEntry(configDir, deps).problems.join(), /bootstrap .* is not the one of this version/);
    fs.rmSync(boot);
    assert.match(inspectStartupEntry(configDir, deps).problems.join(), /bootstrap .* is missing/);
  });

  test('the baked node gone (an nvm version removed) is broken; the repair bakes the node of the caller', () => {
    const s = winSetup({ nodePath: path.join(tmp(), 'removed-node', 'node.exe') });
    assert.equal(enableStartup(s.configDir, s.deps).ok, true);
    const report = inspectStartupEntry(s.configDir, s.deps);
    assert.equal(report.state, 'broken');
    assert.match(report.problems.join(), /the node .*removed-node.* is gone/);
    const fixed = { ...s.deps, nodePath: process.execPath };
    const { repair } = repairStartupEntry(s.configDir, fixed);
    assert.equal(repair.ok, true);
    assert.equal(inspectStartupEntry(s.configDir, fixed).state, 'ok');
  });

  test('an entry that starts another node than the caller\'s is a drift, never rewritten', () => {
    const { configDir, deps } = win();
    const r = inspectStartupEntry(configDir, { ...deps, nodeBinDir: path.join(tmp(), 'other-node') });
    assert.equal(r.state, 'drift');
    assert.match(r.problems.join(), /under the node in .*this orch runs under the node in .*other-node/);
    assert.equal(repairStartupEntry(configDir, { ...deps, nodeBinDir: path.join(tmp(), 'other-node') }).repair, null);
  });

  test('NEW ENTRY, OLD PACKAGE: an entry for the watchdog over an install without it is broken, and repaired to the Go launcher', () => {
    const s = linuxSetup();
    assert.equal(enableStartup(s.configDir, s.deps).ok, true);
    const oldPackage = { ...s.deps, watchdogEntry: null };
    const report = inspectStartupEntry(s.configDir, oldPackage);
    assert.equal(report.state, 'broken');
    assert.match(report.problems.join(), /no dist\/orchestrator-watchdog\.cjs \(an older version was installed\?\): it will start the Go launcher instead/);

    const launcher = path.join(tmp(), 'orchestrator-launcher');
    fs.writeFileSync(launcher, '');
    const goDeps = { ...oldPackage, programArguments: [launcher, s.configDir], validateTarget: () => null, daemonEntry: s.install.daemon };
    const { repair } = repairStartupEntry(s.configDir, goDeps);
    assert.equal(repair.ok, true, JSON.stringify(repair));
    const unit = fs.readFileSync(s.unitPath, 'utf8');
    assert.ok(unit.includes(`ExecStart=${systemdQuote(launcher, { exec: true })} `), unit);
    assert.ok(unit.includes('LAUNCHER_BUNDLE_OVERRIDE'), 'the Go entry keeps its bundle');
    assert.equal(inspectStartupEntry(s.configDir, goDeps).state, 'ok');
  });

  test('NEW ENTRY, OLD PACKAGE on Windows: the Run value goes back to the launcher and the files stay harmless', () => {
    const s = win();
    const launcher = path.join(tmp(), 'orchestrator.exe');
    fs.writeFileSync(launcher, '');
    const goDeps = { ...s.deps, watchdogEntry: null, validateTarget: () => null, windowsCommand: `"${launcher}" "${s.configDir}"`, bundleLinkProblem: () => null };
    assert.equal(inspectStartupEntry(s.configDir, goDeps).state, 'broken');
    assert.equal(repairStartupEntry(s.configDir, goDeps).repair.ok, true);
    assert.equal(s.reg.store.get(s.valueName), `"${launcher}" "${s.configDir}"`);
    assert.equal(inspectStartupEntry(s.configDir, goDeps).state, 'ok');
  });
});

describe('OLD ENTRY, NEW PACKAGE: an entry for the Go launcher is outdated and rewritten', () => {
  test('Linux: a launcher unit becomes a bootstrap unit, and the next inspection is ok', () => {
    const s = linuxSetup();
    const launcher = path.join(tmp(), 'orchestrator-launcher');
    fs.writeFileSync(launcher, '');
    fs.mkdirSync(path.dirname(s.unitPath), { recursive: true });
    fs.writeFileSync(s.unitPath, buildSystemdUnit([launcher, s.configDir], s.configDir, [NODE_BIN], s.install.daemon));
    fs.mkdirSync(path.dirname(s.wants), { recursive: true });
    fs.writeFileSync(s.wants, '');
    const report = inspectStartupEntry(s.configDir, s.deps);
    assert.equal(report.state, 'outdated');
    assert.match(report.problems.join(), /still starts the Go launcher; this install starts at login through the Node watchdog/);

    const { repair } = repairStartupEntry(s.configDir, s.deps);
    assert.equal(repair.ok, true, JSON.stringify(repair));
    assert.ok(fs.readFileSync(s.unitPath, 'utf8').includes(`"${path.join(s.configDir, BOOTSTRAP_FILE)}`.replace(/\\/g, '\\\\')));
    assert.deepEqual(inspectStartupEntry(s.configDir, s.deps), { state: 'ok', problems: [] });
  });

  test('Windows: a launcher Run value becomes the wscript value; the reverse (no watchdog in the install) stays ok', () => {
    const s = winSetup();
    const launcher = path.join(tmp(), 'orchestrator.exe');
    fs.writeFileSync(launcher, '');
    s.reg.store.set(s.valueName, `"${launcher}" "${s.configDir}"`);
    const deps = { ...s.deps, bundleLinkProblem: () => null };
    assert.equal(inspectStartupEntry(s.configDir, { ...deps, watchdogEntry: null }).state, 'ok');
    assert.equal(inspectStartupEntry(s.configDir, deps).state, 'outdated');
    assert.equal(repairStartupEntry(s.configDir, deps).repair.ok, true);
    assert.match(s.reg.store.get(s.valueName), /^wscript\.exe \/\/nologo "/);
    assert.equal(inspectStartupEntry(s.configDir, deps).state, 'ok');
  });

  test('macOS: a launcher plist is outdated, then re-registered', () => {
    const install = fakeInstall();
    const dir = tmp();
    const configDir = path.join(dir, 'cfg');
    const plistPath = path.join(dir, 'a.plist');
    const launcher = path.join(dir, 'orchestrator-launcher');
    fs.writeFileSync(launcher, '');
    fs.writeFileSync(plistPath, buildMacPlist([launcher, configDir], configDir, [NODE_BIN], { bundle: install.daemon }));
    const deps = { platform: 'darwin', plistPath, exec: () => '', macPath: shell, watchdogEntry: install.watchdog, nodePath: `${NODE_BIN}/node`, nodeBinDir: NODE_BIN };
    const report = inspectStartupEntry(configDir, deps);
    assert.equal(report.state, 'outdated', JSON.stringify(report));
    assert.equal(repairStartupEntry(configDir, deps).repair.ok, true);
    assert.deepEqual(inspectStartupEntry(configDir, deps), { state: 'ok', problems: [] });
  });
});

describe('startup check: outdated entries are said, never silent', () => {
  const run = (over) => {
    const said = [];
    runStartupCheck({ configDir: tmp(), command: 'status', releaseBuild: true, now: 1, say: (l) => said.push(l), ...over });
    return said;
  };
  const outdated = { state: 'outdated', problems: ['still the Go launcher'] };

  test('rewritten: a notice that names what was outdated', () => {
    const said = run({ repair: () => ({ report: outdated, repair: { ok: true, detail: '' } }) });
    assert.match(said.join('\n'), /Notice: the start-at-login entry was outdated \(still the Go launcher\); it was re-registered/);
  });

  test('rewrite failed: a warning with the reason and `orch install`', () => {
    const said = run({ repair: () => ({ report: outdated, repair: { ok: false, error: 'reg.exe failed: denied' } }) });
    assert.match(said.join('\n'), /Warning: the start-at-login entry is outdated .*could not be re-registered \(reg\.exe failed: denied\).*orch install/);
  });

  test('a development build says it does not rewrite', () => {
    const said = run({ releaseBuild: false, inspect: () => outdated });
    assert.match(said.join('\n'), /outdated .*development build does not rewrite it/);
  });

  test('warnings of a rewrite (Go fallback, no watchdog in the install) are shown', () => {
    const said = run({ repair: () => ({ report: { state: 'broken', problems: ['x'] }, repair: { ok: true, detail: '', warnings: ['the Go launcher is the fallback'] } }) });
    assert.match(said.join('\n'), /Warning: the Go launcher is the fallback/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------
describe('disableStartup removes the bootstrap and the hidden script', () => {
  test('Windows: value, script and bootstrap are gone', () => {
    const { configDir, reg, deps, valueName } = winSetup();
    enableStartup(configDir, deps);
    const r = disableStartup(configDir, deps);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(reg.store.has(valueName), false);
    assert.ok(!fs.existsSync(path.join(configDir, START_VBS_FILE)));
    assert.ok(!fs.existsSync(path.join(configDir, BOOTSTRAP_FILE)));
    assert.match(r.detail, /removed orchestrator-start\.cjs, orchestrator-start\.vbs/);
  });

  test('Linux: unit and bootstrap are gone', () => {
    const { configDir, unitPath, deps } = linuxSetup();
    enableStartup(configDir, deps);
    assert.equal(disableStartup(configDir, deps).ok, true);
    assert.ok(!fs.existsSync(unitPath));
    assert.ok(!fs.existsSync(path.join(configDir, BOOTSTRAP_FILE)));
  });

  test('macOS: plist and bootstrap are gone; another config dir\'s plist is refused and its files are kept', () => {
    const install = fakeInstall();
    const dir = tmp();
    const plistPath = path.join(dir, 'a.plist');
    const base = { platform: 'darwin', plistPath, exec: () => '', macPath: shell, watchdogEntry: install.watchdog, nodePath: `${NODE_BIN}/node` };
    const mine = path.join(dir, 'mine');
    const other = path.join(dir, 'other');
    enableStartup(mine, base);
    const refused = disableStartup(other, base);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /belongs to another config dir/);
    assert.ok(fs.existsSync(path.join(mine, BOOTSTRAP_FILE)));
    assert.equal(disableStartup(mine, base).ok, true);
    assert.ok(!fs.existsSync(plistPath));
    assert.ok(!fs.existsSync(path.join(mine, BOOTSTRAP_FILE)));
  });

  test('nothing registered and no files: still ok (idempotent)', () => {
    const { configDir, deps } = winSetup();
    assert.equal(disableStartup(configDir, deps).ok, true);
  });
});
