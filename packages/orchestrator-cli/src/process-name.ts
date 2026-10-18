import { execFile } from 'node:child_process';

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
 */
export function lookupProcessName(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const [command, args] = process.platform === 'win32'
      ? ['tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']] as const
      : ['ps', ['-p', String(pid), '-o', 'comm=']] as const;
    execFile(command, args, { windowsHide: true, timeout: LOOKUP_TIMEOUT_MS }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      resolve(parseProcessName(stdout, process.platform === 'win32'));
    });
  });
}

/** `"node.exe","1234","Console",...` on Windows; the bare name on the others. Exported for its tests. */
export function parseProcessName(stdout: string, windows: boolean): string | undefined {
  const line = stdout.split(/\r?\n/).find(l => l.trim() !== '');
  if (line === undefined) {
    return undefined;
  }
  if (!windows) {
    return line.trim();
  }
  // "INFO: No tasks are running which match the specified criteria." is not a name.
  const match = /^"([^"]+)"/.exec(line.trim());
  return match?.[1];
}
