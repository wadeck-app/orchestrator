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

// Resolved lazily: only 'start' needs the Go launcher. Resolving it up front made every
// short-lived command attempt a global npm install and then fail whenever the platform
// package was not resolvable (e.g. from a monorepo checkout).
function resolveLauncher() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const key = `${process.platform}-${arch}`;
  const pkgName = PLATFORM_PKG[key];
  if (!pkgName) {
    process.stderr.write(`orchestrator: unsupported platform ${key}\n`);
    process.exit(1);
  }

  const ext = process.platform === 'win32' ? '.exe' : '';
  try {
    return require.resolve(`${pkgName}/orchestrator${ext}`);
  } catch {
    process.stderr.write(`orchestrator: platform package ${pkgName} missing -- installing...\n`);
  }

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
    return require.resolve(`${pkgName}/orchestrator${ext}`);
  } catch {
    process.stderr.write(
      `orchestrator: installed ${pkgName} but cannot resolve binary -- try: npm install -g @wadeck-app/orchestrator-cli\n`
    );
    process.exit(1);
  }
}

// The CLI entry point (short-lived commands).
const cliBundlePath = path.join(__dirname, '..', 'dist', 'orchestrator-cli.cjs');
// The daemon entry point (long-running) — used as LAUNCHER_BUNDLE_OVERRIDE for 'start'.
// The Go launcher keeps this process alive and watches for sentinel files on exit.
const daemonBundlePath = path.join(__dirname, '..', 'dist', 'orchestrator.cjs');
const _rawArgs = process.argv.slice(2);

// --cli-background / --cli-foreground: explicit stdio override flags (strip before passing to command).
var _hasBackground = _rawArgs.includes('--cli-background');
var _hasForeground = _rawArgs.includes('--cli-foreground');
const args = _rawArgs.filter(function(a) { return a !== '--cli-background' && a !== '--cli-foreground'; });

var _stdio;
if (!_hasBackground && !_hasForeground) {
  // In TTY: fully inherit so the user sees output and can interact.
  // In non-TTY (piped/scripted): ignore stdin to prevent AllocConsole() from libuv
  // (triggered when a GUI-parent passes PIPE handles), but inherit stdout/stderr so
  // commands like `orch tray list` can be used in scripts and their output captured.
  // windowsHide:true below prevents any spurious console window from appearing.
  _stdio = process.stdin.isTTY ? 'inherit' : ['ignore', 'inherit', 'inherit'];
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

// Only 'start' goes through the Go launcher, which owns the daemon lifecycle. Every other
// command runs node directly: on Windows the launcher is built as SUBSYSTEM:WINDOWS, so its
// hasConsole() check fails when spawned from a terminal and node's stdio gets redirected to
// NUL, swallowing all output.
if (args[0] === 'start') {
  // args.slice(1) omits 'start' itself.
  runWithExit(resolveLauncher(), args.slice(1), daemonBundlePath);
} else {
  runWithExit(process.execPath, [cliBundlePath].concat(args), cliBundlePath);
}
