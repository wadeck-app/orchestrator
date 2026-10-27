/**
 * The command line a job or `orch exec` hands to the shell, as ONE string.
 *
 * The bin + args form of spawn with the shell option does not escape anything: it joins `[bin, ...args]` with single spaces and gives the
 * result to the shell, and prints DEP0190 for it. The command used to be cut into tokens (a run of non-blank characters, or a
 * "double" or 'single' quoted string, keeping its quotes) only to be re-joined by node. Joining them here gives the shell the very
 * same bytes and passes it as a single command string to spawn, which is not deprecated.
 *
 * It is NOT the original command: whitespace between tokens becomes one space (a newline too, which a POSIX shell would have
 * read as a command separator), and a stray quote that opens no string is dropped. Both are what ran before, and the supervised
 * path (`_supervisedRequest`) sends the same line, so a direct and a supervised run of one job keep running the same thing.
 */
export function shellCommandLine(command: string): string {
  const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [command];
  return parts.join(' ');
}
