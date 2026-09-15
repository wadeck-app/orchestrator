import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import pidtree from 'pidtree';

const execFileAsync = promisify(execFile);

/** True while the pid exists. Signal 0 performs the permission/existence check only. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Tree kill for callers that must report the outcome to their own caller immediately, and so
 * cannot await. On Windows taskkill tears the tree down inline, preserving the synchronous
 * guarantee the daemon's kill route already had. Elsewhere the walk needs async, so the kill
 * is started and not awaited, which is exactly what the previous SIGTERM-then-SIGKILL code did
 * on those platforms.
 */
export function killTreeSync(rootPid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(rootPid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch { /* already gone */ }
    return;
  }
  void killTree(rootPid);
}

/**
 * Terminates a process and every descendant.
 *
 * Commands are spawned through a shell, so the direct child is a wrapper (cmd.exe / sh) and
 * signalling it alone leaves the real work running: on Windows a signal to cmd.exe does not
 * propagate to its children at all. Killing only the wrapper is what leaked a process per
 * test run, including fixtures that install a SIGTERM handler on purpose, until the runner
 * sat forever waiting on children that would never exit.
 */
export async function killTree(rootPid: number): Promise<void> {
  if (process.platform === 'win32') {
    // /T covers the tree; /F is required because the wrapper forwards nothing and a target
    // may ignore a graceful signal.
    try {
      await execFileAsync('taskkill', ['/T', '/F', '/PID', String(rootPid)], { windowsHide: true });
    } catch { /* already gone */ }
    return;
  }

  let pids: number[];
  try {
    pids = await pidtree(rootPid, { root: true });
  } catch {
    // The walk fails once the root is gone; still try the root, it may just have no children.
    pids = [rootPid];
  }

  // Deepest first, so a parent cannot spawn more work while its children are being torn down.
  for (const pid of [...pids].reverse()) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 300));
  for (const pid of pids) {
    if (isAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
}
