/**
 * The environment a job (or an `orch exec` command) is started with.
 *
 * Jobs are spawned with a pipe, so most programs would print plain text -- unless the environment forces colour: a
 * daemon started from a shell with FORCE_COLOR=1 or CLICOLOR_FORCE=1 passed that on to every dev server, and the
 * run logs filled with escape codes. Unless `jobsNoColor: false` is set in config.yml, a job therefore gets:
 *
 *   NO_COLOR=1       the convention (no-color.org), honoured by most tools
 *   FORCE_COLOR=0    because chalk / supports-color / node's own tty.hasColors read FORCE_COLOR BEFORE NO_COLOR, so
 *                    NO_COLOR alone loses against an inherited FORCE_COLOR=1; 0 is their "no colour" value
 *   CLICOLOR_FORCE   removed (a CLICOLOR_FORCE=1 inherited from the shell beats NO_COLOR in tools that use it)
 *
 * The job's own `env` (and its secrets) win, per variable: a job that sets FORCE_COLOR=1 keeps it, and still gets
 * NO_COLOR=1 unless it sets that too. TERM and COLORTERM are left alone on purpose: with a pipe for stdout no program
 * believes it is on a terminal, and changing TERM (to "dumb") would also change how tools behave about cursor
 * control and progress, which is not what was asked.
 *
 * Variable names are case-insensitive on Windows, so `no_color` in a job's env is that job's NO_COLOR there.
 */
export function jobEnvironment(
  base: NodeJS.ProcessEnv,
  jobEnv: NodeJS.ProcessEnv | undefined,
  noColor: boolean,
  secretEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (!noColor) {
    return env;
  }
  const insensitive = process.platform === 'win32';
  const same = (a: string, b: string): boolean => (insensitive ? a.toUpperCase() === b.toUpperCase() : a === b);
  const definedByJob = (name: string): boolean =>
    [jobEnv, secretEnv].some((own) => own !== undefined && Object.keys(own).some((k) => same(k, name)));
  const keysOf = (name: string): string[] => Object.keys(env).filter((k) => same(k, name));

  // Set under the name the environment already uses, so Windows never ends up with two spellings of one variable.
  const set = (name: string, value: string): void => {
    for (const k of keysOf(name)) {
      delete env[k];
    }
    env[name] = value;
  };

  if (!definedByJob('NO_COLOR')) {
    set('NO_COLOR', '1');
  }
  if (!definedByJob('FORCE_COLOR')) {
    set('FORCE_COLOR', '0');
  }
  if (!definedByJob('CLICOLOR_FORCE')) {
    for (const k of keysOf('CLICOLOR_FORCE')) {
      delete env[k];
    }
  }
  return env;
}
