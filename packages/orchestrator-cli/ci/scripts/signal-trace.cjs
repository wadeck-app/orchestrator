'use strict';

// Evidence for the ubuntu runs where the whole `node --test` run is interrupted ("Interrupted while running", every
// file cancelled) and nothing says who signalled it. Loaded in CI through NODE_OPTIONS=--require, it changes no
// behaviour and records two things in $SIGNAL_TRACE_LOG:
//   - every process.kill() aimed at a process group (pid <= 0), at init (pid 1) or at the caller's own parent,
//     with the caller's stack: those are the kills that can reach the runner;
//   - in the test runner only, the signal that interrupts it, with the process table at that moment.
// The log is appended synchronously: a signalled process has no time for anything asynchronous.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const logFile = process.env.SIGNAL_TRACE_LOG;
if (!logFile) {
  throw new Error('signal-trace: SIGNAL_TRACE_LOG is not set. Set it to the file the evidence is appended to; this preload is only meant to be loaded through NODE_OPTIONS in CI.');
}

function log(message) {
  const who = `pid=${process.pid} ppid=${process.ppid} ${path.basename(process.argv[1] ?? '-')}`;
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${who} ${message}\n`);
}

function processTable() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid,ppid,pgid,stat,etime,command'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    return out.split('\n').slice(0, 150).map((line) => line.slice(0, 200)).join('\n');
  } catch (error) {
    return `ps failed: ${error.message}`;
  }
}

const realKill = process.kill;

process.kill = function patchedKill(pid, signal, ...rest) {
  const target = Number(pid);
  const sent = signal === undefined ? 'SIGTERM' : signal;
  const isLivenessCheck = sent === 0 || sent === '0';
  if (!isLivenessCheck && (!(target > 1) || target === process.ppid)) {
    const stack = new Error('caller').stack.split('\n').slice(2, 9).join('\n');
    log(`kill pid=${pid} sig=${sent}${target === process.ppid ? ' (its parent)' : ''}\n${stack}`);
  }
  return realKill.call(this, pid, signal, ...rest);
};

if (process.execArgv.includes('--test')) {
  for (const received of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const onSignal = () => {
      log(`received ${received}; process table:\n${processTable()}`);
      // Hand the signal back: whatever the runner does with it (print what it was running, exit) still happens.
      process.removeListener(received, onSignal);
      realKill.call(process, process.pid, received);
    };
    process.on(received, onSignal);
  }
}
