'use strict';

// Ends what a test file left running in the config dirs it created.
//
// The supervision tests start real supervisors and real jobs on purpose, and several of them walk away from the
// run on purpose too (a daemon that detaches, a supervisor killed to see the run reported as lost). Nothing then
// ended the job: a server loop kept running after the suite, and `strace -f` in CI, which waits for every
// descendant, held the step until its timeout although all the tests had passed.
//
// The status files name the supervisor and the shell around the job, but not the job itself, and by the time a
// test is over that shell is often gone and the job is an orphan nobody can reach through a pid. What identifies it
// is its command line: it runs a script that lives in the test's own config dir, a mkdtemp folder no other process
// has in its command line. So the sweep ends every process whose command line names one of those folders, plus the
// pids the status files do hold. One look at the process table for the whole file, not one per test.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { killTree } = require('../../src/process-tree');

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidsInRunFolders(configDir) {
  const root = path.join(configDir, 'runs');
  if (!fs.existsSync(root)) {
    return [];
  }
  const pids = [];
  for (const job of fs.readdirSync(root)) {
    for (const run of fs.readdirSync(path.join(root, job))) {
      let status;
      try {
        status = JSON.parse(fs.readFileSync(path.join(root, job, run, 'status.json'), 'utf8'));
      } catch {
        // No status written (the supervisor never started): there is nothing of it to end.
        continue;
      }
      for (const pid of [status.supervisorPid, status.childPid]) {
        if (Number.isInteger(pid) && pid > 1) {
          pids.push(pid);
        }
      }
    }
  }
  return pids;
}

/** Pids of the processes whose command line contains one of the folders. Throws if the process table cannot be read. */
function pidsMentioning(folders) {
  if (folders.length === 0) {
    return [];
  }
  if (process.platform === 'win32') {
    const wanted = folders.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
    const script = `$w = @(${wanted}); Get-CimInstance Win32_Process | Where-Object { $p = $_; $p.ProcessId -ne $PID -and $p.CommandLine -and ($w | Where-Object { $p.CommandLine.Contains($_) }) } | ForEach-Object { $_.ProcessId }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 1);
  }
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', windowsHide: true });
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[1]) !== process.pid && folders.some((f) => match[2].includes(f)) ? [Number(match[1])] : [];
  });
}

/** @param {string[]} configDirs the config dirs the test file created. */
async function endLeftoverRuns(configDirs) {
  const pids = new Set([...configDirs.flatMap(pidsInRunFolders), ...pidsMentioning(configDirs)]);
  for (const pid of pids) {
    if (pid !== process.pid && isAlive(pid)) {
      await killTree(pid);
    }
  }
}

module.exports = { endLeftoverRuns };
