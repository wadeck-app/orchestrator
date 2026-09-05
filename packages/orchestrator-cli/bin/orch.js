#!/usr/bin/env node
'use strict';
const { execFileSync, execSync } = require('child_process');
const path = require('path');
const os = require('os');

const PLATFORM_PKG = {
  'win32-x64':    '@wadeck-app/orchestrator-cli-win32-x64',
  'darwin-arm64': '@wadeck-app/orchestrator-cli-darwin-arm64',
  'darwin-x64':   '@wadeck-app/orchestrator-cli-darwin-x64',
};

const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
const key = `${process.platform}-${arch}`;
const pkgName = PLATFORM_PKG[key];
if (!pkgName) {
  process.stderr.write(`orchestrator: unsupported platform ${key}\n`);
  process.exit(1);
}

const ext = process.platform === 'win32' ? '.exe' : '';

let launcherPath;
try {
  launcherPath = require.resolve(`${pkgName}/orchestrator${ext}`);
} catch {
  process.stderr.write(`orchestrator: platform package ${pkgName} missing -- installing...\n`);
  try {
    const out = execSync(`npm install -g ${pkgName}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (out) process.stdout.write(out);
  } catch (installErr) {
    if (installErr.stdout) process.stdout.write(installErr.stdout);
    if (installErr.stderr) process.stderr.write(installErr.stderr);
    process.stderr.write(`orchestrator: install failed (exit ${installErr.status})\n`);
    process.exit(1);
  }
  try {
    launcherPath = require.resolve(`${pkgName}/orchestrator${ext}`);
  } catch {
    process.stderr.write(
      `orchestrator: installed ${pkgName} but cannot resolve binary -- try: npm install -g @wadeck-app/orchestrator-cli\n`
    );
    process.exit(1);
  }
}

// The CLI entry point (short-lived commands).
const cliBundlePath = path.join(__dirname, '..', 'dist', 'cli.js');
// The daemon entry point (long-running) — used as LAUNCHER_BUNDLE_OVERRIDE for 'start'.
// The Go launcher keeps this process alive and watches for sentinel files on exit.
const daemonBundlePath = path.join(__dirname, '..', 'dist', 'index.js');
const _rawArgs = process.argv.slice(2);

// --cli-background / --cli-foreground: explicit stdio override flags (strip before passing to command).
var _hasBackground = _rawArgs.includes('--cli-background');
var _hasForeground = _rawArgs.includes('--cli-foreground');
const args = _rawArgs.filter(function(a) { return a !== '--cli-background' && a !== '--cli-foreground'; });

var _stdio;
if (!_hasBackground && !_hasForeground) {
  // Auto-detect: pipe context (non-TTY) → NUL handles to prevent AllocConsole() from libuv
  // when a GUI-parent (orch.exe SUBSYSTEM:WINDOWS) passes PIPE handles.
  _stdio = process.stdin.isTTY ? 'inherit' : 'ignore';
} else {
  _stdio = 'ignore';
  for (var _i = 0; _i < _rawArgs.length; _i++) {
    if (_rawArgs[_i] === '--cli-background') _stdio = 'ignore';
    if (_rawArgs[_i] === '--cli-foreground') _stdio = 'inherit';
  }
}

function runWithExit(bin, binArgs, bundleOverride) {
  try {
    execFileSync(bin, binArgs, {
      stdio: _stdio,
      windowsHide: true,
      env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundleOverride },
    });
  } catch (err) {
    process.exit(err != null && typeof err === 'object' && 'status' in err ? err.status || 1 : 1);
  }
}

// On Windows the Go launcher binary is compiled as SUBSYSTEM:WINDOWS (GUI application).
// Its hasConsole() check fails when spawned from a terminal, causing node's stdio to be
// redirected to NUL and swallowing all output. Bypass the launcher for all commands
// except 'start' so their output reaches the terminal.
var _bypassLauncher = args[0] !== 'start';

if (process.platform === 'win32' && _bypassLauncher) {
  runWithExit(process.execPath, [cliBundlePath].concat(args), cliBundlePath);
} else if (_bypassLauncher) {
  runWithExit(process.execPath, [cliBundlePath].concat(args), cliBundlePath);
} else {
  // 'start': use Go launcher with daemon entry point; pass args.slice(1) (omit 'start').
  runWithExit(launcherPath, args.slice(1), daemonBundlePath);
}
