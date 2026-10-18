import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * tasklist measured 1.9 s on a loaded Windows machine, so this is patient. The kill path does not wait
 * for it: _describeTree caps the whole lookup at 2 s and kills regardless.
 */
const LOOKUP_TIMEOUT_MS = 5000;

/**
 * The executable name of a running process, or undefined when it cannot be found.
 *
 * Only used to make a resource-limit kill explain itself ("pid 4242 is chatgpt-scraper.exe"), so a
 * failure is an absent name and never an error: the kill has to go ahead whether or not the lookup
 * worked. Hidden on Windows because this runs from the daemon, which has no console to show it on.
 *
 * Never the command line: arguments can carry secrets, and this ends up in a log file.
 */
export function lookupProcessName(pid: number): Promise<string | undefined> {
  if (process.platform === 'linux') {
    // `ps -o comm=` prints the name of the THREAD on Linux, and a Node process answers "MainThread",
    // which names nothing. The executable the kernel mapped is the honest answer.
    try {
      return Promise.resolve(path.basename(fs.readlinkSync(`/proc/${pid}/exe`)));
    } catch {
      return Promise.resolve(undefined);
    }
  }
  return new Promise((resolve) => {
    const windows = process.platform === 'win32';
    const [command, args] = windows
      ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] as const
      : ['ps', ['-p', String(pid), '-o', 'comm=']] as const;
    execFile(command, args, { windowsHide: true, timeout: LOOKUP_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(parseProcessName(stdout, windows));
    });
  });
}

/**
 * `"node.exe","1234","Console",...` on Windows; on macOS `ps` prints the full path, of which only the
 * file name is kept. Exported for its tests.
 */
export function parseProcessName(stdout: string, windows: boolean): string | undefined {
  const line = stdout.split(/\r?\n/).find(l => l.trim() !== '');
  if (line === undefined) {
    return undefined;
  }
  if (!windows) {
    return path.basename(line.trim());
  }
  // "INFO: No tasks are running which match the specified criteria." is not a name.
  const match = /^"([^"]+)"/.exec(line.trim());
  return match?.[1];
}
