/**
 * Start at login through the Node watchdog: the files `orch install` (and every daemon start) writes into the config dir.
 *
 *  - `<configDir>/orchestrator-start.cjs`: a tiny STABLE bootstrap (BOOTSTRAP_SOURCE, plain CJS, no dependency). The login entry
 *    runs `node orchestrator-start.cjs <configDir> [hint]`; it finds the CURRENT installed package's
 *    dist/orchestrator-watchdog.cjs at every login and runs it IN-PROCESS (one resident node, the pid in config.launcher-pid is
 *    this process). Registering the watchdog's own path instead would freeze it: an `nvm use`, a node upgrade or a moved npm
 *    prefix leaves a path that is gone (the bug the Go launcher avoided by resolving its bundle dynamically).
 *  - Windows only, `<configDir>/orchestrator-start.vbs`: the Run value is `wscript.exe //nologo "<vbs>"`; the script starts the
 *    bootstrap with window style 0 (SW_HIDE, no console flash) without a shell (docs/windows-hidden-process.md).
 *
 * Nothing here runs a process or touches the registry: orch's own `startup.ts` calls these.
 */
import fs from 'node:fs';
import path from 'node:path';

export const BOOTSTRAP_FILE = 'orchestrator-start.cjs';
export const START_VBS_FILE = 'orchestrator-start.vbs';

/**
 * The bootstrap. Static text: versioned by its first line, rewritten by orch only when the text on disk differs. Keep it free of
 * backticks and dollar-brace sequences (it lives in a template literal here). When run directly it resolves and loads the
 * watchdog; when required (tests) it exports run() and resolveWatchdog() so every effect can be injected.
 */
export const BOOTSTRAP_SOURCE = String.raw`// orchestrator-start v1: written by orch for start at login and rewritten when this text changes. Do not edit.
'use strict';
var fs = require('fs');
var os = require('os');
var path = require('path');

var WATCHDOG = 'orchestrator-watchdog.cjs';
var DAEMON = 'orchestrator.cjs';
var PKG_DIST = ['@wadeck-app', 'orchestrator-cli', 'dist'];
var INSTALL = 'npm install -g @wadeck-app/orchestrator-cli';

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function distIn(modulesDir) { return path.join.apply(path, [modulesDir].concat(PKG_DIST)); }

/**
 * The dist folders that may hold the CURRENT install, in the order the Go launcher looked for its bundle: the override, then the
 * modules of the node that runs us (a Windows installer or nvm-windows keeps them next to node.exe, a unix prefix in ../lib),
 * then the npm prefix of the environment (Windows default: %APPDATA%\npm, outside node's folder), and last the install seen when
 * the entry was written (argv[3]: it can be stale after an nvm use, so it comes last). Each entry: { dir, via }.
 */
function candidateDirs(opts) {
  var env = opts.env;
  var out = [];
  var seen = {};
  function add(dir, via) {
    var key = opts.platform === 'win32' ? dir.toLowerCase() : dir;
    if (!seen[key]) { seen[key] = true; out.push({ dir: dir, via: via }); }
  }
  var nodeDir = path.dirname(opts.execPath);
  add(distIn(path.join(nodeDir, 'node_modules')), 'node_modules next to ' + opts.execPath);
  if (opts.platform !== 'win32') {
    add(distIn(path.join(nodeDir, '..', 'lib', 'node_modules')), 'lib/node_modules of the node prefix');
  }
  var prefix = env.npm_config_prefix || env.NPM_CONFIG_PREFIX || '';
  if (prefix !== '') {
    add(distIn(opts.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules')), 'npm prefix ' + prefix);
  }
  if (opts.platform === 'win32' && env.APPDATA) {
    add(distIn(path.join(env.APPDATA, 'npm', 'node_modules')), 'the npm folder of %APPDATA%');
  }
  if (opts.hint) {
    add(path.dirname(opts.hint), 'the install seen when the entry was written');
  }
  return out;
}

/**
 * { file, via } for the watchdog to run, or { file: null, problem } with the whole story. LAUNCHER_BUNDLE_OVERRIDE (the daemon
 * bundle, as for the watchdog itself) wins and is never second-guessed: when its folder has no watchdog that is the answer.
 */
function resolveWatchdog(opts) {
  var override = (opts.env.LAUNCHER_BUNDLE_OVERRIDE || '').trim();
  if (override !== '') {
    var sibling = path.join(path.dirname(override), WATCHDOG);
    if (opts.isFile(sibling)) { return { file: sibling, via: 'LAUNCHER_BUNDLE_OVERRIDE' }; }
    return { file: null, problem: 'LAUNCHER_BUNDLE_OVERRIDE points at ' + override + ', and there is no ' + WATCHDOG + ' next to it. Unset it, or point it at the daemon bundle of a current install.' };
  }
  var candidates = candidateDirs(opts);
  var olderIn = null;
  for (var i = 0; i < candidates.length; i++) {
    var file = path.join(candidates[i].dir, WATCHDOG);
    if (opts.isFile(file)) { return { file: file, via: candidates[i].via }; }
    if (olderIn === null && opts.isFile(path.join(candidates[i].dir, DAEMON))) { olderIn = candidates[i].dir; }
  }
  var tried = candidates.map(function (c) { return c.dir; }).join('; ');
  if (olderIn !== null) {
    return { file: null, problem: 'the installed @wadeck-app/orchestrator-cli in ' + olderIn + ' has no ' + WATCHDOG + ' (an older version). Update it with: ' + INSTALL + ' (or run orch start, which registers an entry that matches the installed version).' };
  }
  return { file: null, problem: 'cannot find ' + WATCHDOG + ' of @wadeck-app/orchestrator-cli (looked in: ' + tried + '). Install it with: ' + INSTALL + ', then run: orch install' };
}

function realIo() {
  return {
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    isFile: function (f) { try { return fs.statSync(f).isFile(); } catch (e) { return false; } },
    now: function () { return new Date(); },
    mkdirp: function (d) { fs.mkdirSync(d, { recursive: true }); },
    append: function (f, t) { fs.appendFileSync(f, t); },
    tmpdir: function () { return os.tmpdir(); },
    stderr: function (t) { try { process.stderr.write(t); } catch (e) { /* no console at login */ } },
    load: function (f) { require(f); },
    setArgv: function (a) { process.argv = a; }
  };
}

/** Same file and line format as the watchdog's own log: <configDir>/logs/YYYY-MM-DD-launcher.log. */
function log(io, configDir, level, message) {
  var d = io.now();
  var line = '[' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) + '] [' + ('     ' + level).slice(-5) + '] [launcher] ' + message + '\n';
  try {
    var dir = path.join(configDir, 'logs');
    io.mkdirp(dir);
    io.append(path.join(dir, d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-launcher.log'), line);
  } catch (e) {
    try { io.append(path.join(io.tmpdir(), 'orchestrator-launcher-fallback.log'), 'cannot write ' + configDir + ' (' + e.message + ')\n' + line); } catch (e2) { /* stderr below has it */ }
  }
  io.stderr(line);
}

/** null once the watchdog took over (it ends the process itself), else the exit code. */
function run(argv, io) {
  var configDir = argv[2];
  if (!configDir) {
    io.stderr('orchestrator-start: no config dir given. Usage: node orchestrator-start.cjs <configDir>. Run: orch install\n');
    return 2;
  }
  var found = resolveWatchdog({ env: io.env, execPath: io.execPath, platform: io.platform, hint: argv[3] || '', isFile: io.isFile });
  if (found.file === null) {
    log(io, configDir, 'ERROR', 'start at login: ' + found.problem);
    return 1;
  }
  log(io, configDir, 'INFO', 'start at login: running ' + found.file + ' (found via ' + found.via + ') on ' + io.execPath);
  // The watchdog reads its own argv: only the config dir, as when orch start runs it.
  io.setArgv([io.execPath, found.file, configDir]);
  try {
    io.load(found.file);
  } catch (e) {
    log(io, configDir, 'ERROR', 'start at login: ' + found.file + ' could not be loaded (' + e.message + '). Re-install with: ' + INSTALL + ', then run: orch install');
    return 1;
  }
  return null;
}

module.exports = { resolveWatchdog: resolveWatchdog, run: run };

if (require.main === module) {
  var code = run(process.argv, realIo());
  if (code !== null) { process.exit(code); }
}
`;

// ---- Windows: the hidden VBS -------------------------------------------------------------------------

/** One argument of a CreateProcess command line. A double quote cannot be in a Windows path, so it is refused, not escaped. */
function winArg(value: string): string {
  if (/["\r\n\x00]/.test(value)) {
    throw new Error(`cannot put ${JSON.stringify(value)} in the Windows login command: it contains a double quote or a control character`);
  }
  // A trailing backslash would escape the closing quote.
  return `"${value.replace(/\\+$/, (m) => m + m)}"`;
}

const vbsString = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** The arguments of the login command: node, the bootstrap, the config dir and (optional) the install seen now. */
export function bootstrapArgs(opts: { node: string; configDir: string; hint: string | null }): string[] {
  return [opts.node, path.join(opts.configDir, BOOTSTRAP_FILE), opts.configDir, ...(opts.hint === null ? [] : [opts.hint])];
}

/**
 * The VBS the Run value starts: window style 0 (SW_HIDE), do not wait. A start that fails (the baked node is gone) would show a
 * modal Windows Script Host dialog nobody reads, so it is written to the launcher log instead, in the same line format.
 */
export function buildStartVbs(args: readonly string[], configDir: string): string {
  const command = args.map(winArg).join(' ');
  return [
    "' Written by orch for start at login and rewritten at every daemon start: do not edit.",
    'Dim oShell, oFso, oLog, d, logDir, reason',
    'Set oShell = CreateObject("WScript.Shell")',
    'On Error Resume Next',
    `oShell.Run ${vbsString(command)}, 0, False`,
    'If Err.Number <> 0 Then',
    // Run on a missing file raises an error with an empty description: the number is then all there is.
    '  reason = Err.Description',
    '  If reason = "" Then reason = "error 0x" & Hex(Err.Number)',
    '  Err.Clear',
    '  Set oFso = CreateObject("Scripting.FileSystemObject")',
    // A VBS only ever runs on Windows: the path is a Windows path whatever platform builds the text.
    `  logDir = ${vbsString(path.win32.join(configDir, 'logs'))}`,
    '  If Not oFso.FolderExists(logDir) Then oFso.CreateFolder logDir',
    '  d = Now',
    '  Set oLog = oFso.OpenTextFile(logDir & "\\" & Year(d) & "-" & Right("0" & Month(d), 2) & "-" & Right("0" & Day(d), 2) & "-launcher.log", 8, True)',
    '  oLog.WriteLine "[" & Right("0" & Hour(d), 2) & ":" & Right("0" & Minute(d), 2) & ":" & Right("0" & Second(d), 2) & "] [ERROR] [launcher] start at login: wscript could not start node (" & reason & "). The node path baked in the login entry may be gone: run orch install"',
    '  oLog.Close',
    'End If',
    '',
  ].join('\r\n');
}

/** What wscript reads: UTF-16 little endian with a byte order mark, the only encoding that keeps a non-ASCII path intact. */
export function encodeVbs(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

export function decodeVbs(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le');
  }
  throw new Error('the start-at-login script has no UTF-16 byte order mark (it was not written by orch)');
}

/** The Run value: no shell, nothing but the script path. Works the same typed by hand in cmd.exe. */
export function buildRunValue(vbsPath: string): string {
  return `wscript.exe //nologo ${winArg(vbsPath)}`;
}

/** The script path out of a Run value written by buildRunValue, or null (another kind of value, e.g. the Go launcher's). */
export function parseRunValue(value: string): string | null {
  const m = /^wscript\.exe\s+\/\/nologo\s+"((?:[^"]|"")*)"\s*$/i.exec(value.trim());
  return m ? (m[1] ?? '').replace(/\\\\$/, '\\') : null;
}

/** The arguments of the command line inside a script written by buildStartVbs, or null. */
export function parseStartVbs(text: string): string[] | null {
  const m = /^oShell\.Run "((?:[^"]|"")*)", 0, False\r?$/m.exec(text);
  if (!m) {
    return null;
  }
  const command = (m[1] ?? '').replace(/""/g, '"');
  // winArg doubles a trailing backslash (it would escape the closing quote); undone here.
  return [...command.matchAll(/"([^"]*)"/g)].map((a) => (a[1] ?? '').replace(/\\\\$/, '\\'));
}

// ---- writing ----------------------------------------------------------------------------------------

/** Writes the file only when its content differs (atomic: temp then rename). 'unchanged' | 'written'. */
export function writeIfChanged(file: string, content: string | Buffer): 'unchanged' | 'written' {
  const want = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  try {
    if (fs.readFileSync(file).equals(want)) {
      return 'unchanged';
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, want);
  fs.renameSync(tmp, file);
  return 'written';
}

/** Removes the bootstrap and the VBS of a config dir (what `orch uninstall` leaves nothing of). Names the ones it removed. */
export function removeStartFiles(configDir: string): string[] {
  const removed: string[] = [];
  for (const name of [BOOTSTRAP_FILE, START_VBS_FILE]) {
    const file = path.join(configDir, name);
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true });
      removed.push(name);
    }
  }
  return removed;
}
