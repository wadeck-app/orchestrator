#!/usr/bin/env node
'use strict';
// Thin shim: every command, including 'start', goes to the CLI bundle. The CLI owns daemon
// lifecycle decisions (spawning the Go launcher detached, --follow vs exit) so that logic
// stays in one place, in TypeScript, and is testable. This shim must not special-case any
// command: doing that for 'start' ran the windowsgui launcher through execFileSync, whose
// output goes to NUL, so `orch start` printed nothing and never returned.
const { execFileSync } = require('child_process');
const path = require('path');

const cliBundlePath = path.join(__dirname, '..', 'dist', 'orchestrator-cli.cjs');
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

try {
  execFileSync(process.execPath, [cliBundlePath].concat(args), { stdio: _stdio, windowsHide: true });
} catch (err) {
  process.exit(err != null && typeof err === 'object' && 'status' in err ? err.status || 1 : 1);
}
