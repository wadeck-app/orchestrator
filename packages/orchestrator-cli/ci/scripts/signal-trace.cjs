'use strict';

// Evidence for the ubuntu runs where the whole `node --test` run is killed (run 419: "Interrupted while running", 47
// files cancelled; run 421: the step ends with "Terminated", exit code 143) and nothing says who signalled it.
// Loaded in CI through NODE_OPTIONS=--require, it changes no behaviour and records, in $SIGNAL_TRACE_LOG, every
// process.kill() aimed at a process group (pid <= 0), at init (pid 1) or at the caller's own parent, with the
// caller's stack: those are the kills that can reach the runner. Kills made by anything that is not node (the Go
// supervisor) are what the strace in the workflow records. The log is appended synchronously.
const fs = require('node:fs');
const path = require('node:path');

const logFile = process.env.SIGNAL_TRACE_LOG;
if (!logFile) {
  throw new Error('signal-trace: SIGNAL_TRACE_LOG is not set. Set it to the file the evidence is appended to; this preload is only meant to be loaded through NODE_OPTIONS in CI.');
}

function log(message) {
  const who = `pid=${process.pid} ppid=${process.ppid} ${path.basename(process.argv[1] ?? '-')}`;
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${who} ${message}\n`);
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
