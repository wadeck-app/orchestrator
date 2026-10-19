'use strict';

// Ends what a test file left running in the config dirs it created.
//
// The supervision tests start real supervisors and real jobs on purpose, and several of them walk away from the
// run on purpose too (a daemon that detaches, a supervisor killed to see the run reported as lost). Nothing then
// ended the job: a server loop kept running after the suite, and `strace -f` in CI, which waits for every
// descendant, held the step until its timeout although all the tests had passed.
//
// Where the pids come from. The status files name the supervisor and the shell around the job, but by the time a
// test is over that shell is often gone and the job is an orphan nobody can reach through it. So the jobs of these
// tests are written with `withPidFile`: the job records its own pid next to its script. No process table is read to
// find them, which matters on Windows, where that read goes through WMI, the service the resource-sampling tests
// already depend on being quick.
//
// Before anything is ended, a pid that is still alive is checked to be what it was: its command line must name one
// of the test's config dirs (mkdtemp folders, which no other process mentions). That check is the only look at the
// process table, and it happens only for pids that are still alive, so normally none.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { killTree } = require('../../src/process-tree');

const PID_SUFFIX = '.pid';

/** A job script that records its own pid in `<script>.pid` before doing anything else. */
function withPidFile(source) {
  return `require('node:fs').appendFileSync(__filename + ${JSON.stringify(PID_SUFFIX)}, process.pid + '\\n');\n${source}`;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function pidsRecordedIn(configDir) {
  const pids = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Logs, telemetry and the run folders hold no pid files of this kind; the status files are read below.
        if (['logs', 'telemetry', 'runs'].includes(entry.name)) {
          continue;
        }
        walk(file);
      } else if (entry.name.endsWith(PID_SUFFIX)) {
        pids.push(...fs.readFileSync(file, 'utf8').split('\n').map(Number));
      }
    }
  };
  walk(configDir);

  const root = path.join(configDir, 'runs');
  if (fs.existsSync(root)) {
    for (const job of fs.readdirSync(root)) {
      for (const run of fs.readdirSync(path.join(root, job))) {
        try {
          const status = JSON.parse(fs.readFileSync(path.join(root, job, run, 'status.json'), 'utf8'));
          pids.push(status.supervisorPid, status.childPid);
        } catch {
          // No status written (the supervisor never started): there is nothing of it to end.
        }
      }
    }
  }
  return pids.filter((pid) => Number.isInteger(pid) && pid > 1);
}

/** The subset of the pids whose command line names one of the folders. Throws if the process table cannot be read. */
function stillOurs(pids, folders) {
  if (process.platform === 'win32') {
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    const wanted = folders.map((f) => `'${f.replace(/'/g, "''")}'`).join(',');
    const script = `$w = @(${wanted}); Get-CimInstance Win32_Process -Filter '${filter}' | Where-Object { $p = $_; $p.CommandLine -and ($w | Where-Object { $p.CommandLine.Contains($_) }) } | ForEach-Object { $_.ProcessId }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
    return out.split(/\r?\n/).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 1);
  }
  const out = execFileSync('ps', ['-axo', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8', windowsHide: true });
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    return match && folders.some((f) => match[2].includes(f)) ? [Number(match[1])] : [];
  });
}

/** @param {string[]} configDirs the config dirs the test file created. */
async function endLeftoverRuns(configDirs) {
  const alive = [...new Set(configDirs.flatMap(pidsRecordedIn))].filter((pid) => pid !== process.pid && isAlive(pid));
  if (alive.length === 0) {
    return;
  }
  for (const pid of stillOurs(alive, configDirs)) {
    await killTree(pid);
  }
}

module.exports = { endLeftoverRuns, withPidFile };
