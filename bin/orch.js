#!/usr/bin/env node
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');

const LAUNCHER_NAMES = {
  'win32':  'orchestrator_windows_release.exe',
  'darwin': os.arch() === 'arm64' ? 'orchestrator_darwin_arm64_release' : 'orchestrator_darwin_amd64_release',
};

const launcherName = LAUNCHER_NAMES[process.platform];
const cliBundlePath = path.join(__dirname, '..', 'dist', 'cli.js');
// The daemon entry point (long-running) — used as LAUNCHER_BUNDLE_OVERRIDE for 'start'.
// The Go launcher keeps this process alive and watches for sentinel files on exit.
const daemonBundlePath = path.join(__dirname, '..', 'dist', 'index.js');
const args = process.argv.slice(2);

function runWithExit(bin, binArgs, bundleOverride) {
  try {
    execFileSync(bin, binArgs, {
      stdio: 'inherit',
      env: { ...process.env, LAUNCHER_BUNDLE_OVERRIDE: bundleOverride },
    });
  } catch (err) {
    process.exit(err != null && typeof err === 'object' && 'status' in err ? err.status || 1 : 1);
  }
}

// Use Go launcher for 'start' with daemon entry point (index.js) as override.
// The launcher stays alive as the daemon's parent, enabling sentinel-based updates.
// All other commands bypass the launcher (faster, avoids console window issues on Windows).
if (launcherName && args[0] === 'start') {
  const launcherPath = path.join(__dirname, '..', 'launcher-go', 'dist', launcherName);
  runWithExit(launcherPath, args.slice(1), daemonBundlePath);
} else {
  runWithExit(process.execPath, [cliBundlePath].concat(args), cliBundlePath);
}
