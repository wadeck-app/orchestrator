import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { getErrorMessage } from './fsUtil.js';
import path from 'node:path';

/**
 * The PATH a macOS launchd-started daemon (and so every job it runs) gets.
 *
 * launchd never reads ~/.zshrc, so a tool installed under ~/.local/bin (the native `claude`) or
 * /opt/homebrew/bin was invisible to jobs although every terminal found it. The plist therefore
 * carries the PATH of the user's login shell, captured when the plist is written (every daemon
 * start). It is frozen there: a later rc-file edit applies at the next plist write.
 *
 * Everything here is pure or takes its side effects as arguments, so Windows/Linux tests drive it
 * with a faked shell. Only `realShellRunner` touches a process, and only production passes it.
 */

const START_MARKER = '__ORCH_PATH_START__';
const END_MARKER   = '__ORCH_PATH_END__';

export const SHELL_CAPTURE_TIMEOUT_MS = 5000;
export const DEFAULT_MAC_SHELL        = '/bin/zsh';

/** The entries the plist always carried; they stay, after the user's, so /usr/bin etc. are never lost. */
export const LEGACY_MAC_PATH = ['/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

const MAX_ENTRIES      = 100;
const MAX_ENTRY_LENGTH = 1024;
const SNIPPET_LENGTH   = 300;

export interface ShellRunResult {
  /** Exit code, or null when the shell was killed / never ran. */
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  /** Spawn failure (ENOENT, EACCES...), already phrased. */
  error?: string;
}

export type ShellRunner = (shell: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => ShellRunResult;

export interface MacPathDeps {
  runShell: ShellRunner;
  /** Value of $SHELL as the daemon sees it. */
  shellEnv: string | undefined;
  isExecutableFile: (p: string) => boolean;
  home: string;
  nodeBinDir: string;
  /** Environment the login shell is derived from (HOME, USER...). Its PATH is deliberately NOT passed on. */
  env: NodeJS.ProcessEnv;
  /** Shell used when $SHELL is unusable. Default /bin/zsh (macOS); Linux passes /bin/sh. */
  defaultShell?: string;
  /** Entries written when the capture fails, before the fixed ones. Default ~/.local/bin and homebrew (macOS). */
  fallbackEntries?: readonly string[];
  /** What the entry is called in messages: 'plist' (default) or 'unit file'. */
  entryName?: string;
  /** Where the user's shell setup lives, for the fix sentence. Default '~/.zshrc or ~/.zprofile'. */
  rcFiles?: string;
}

export interface MacPathPlan {
  entries: string[];
  /** Actionable sentences, delivered by the caller through the daemon log. Empty when all went well. */
  warnings: string[];
  captured: boolean;
}

export function realShellRunner(shell: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): ShellRunResult {
  // execFile semantics: no intermediate shell, args are not re-parsed. SIGKILL because an
  // interactive shell ignores SIGTERM, so a hanging rc file would outlive the timeout.
  const r = spawnSync(shell, args, {
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status:   r.status,
    stdout:   r.stdout ?? '',
    stderr:   r.stderr ?? '',
    timedOut: code === 'ETIMEDOUT',
    error:    r.error && code !== 'ETIMEDOUT' ? getErrorMessage(r.error) : undefined,
  };
}

export function realIsExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) {
      return false;
    }
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The text between the LAST start marker and the next end marker; null when the shell did not print both. */
export function extractMarkedPath(stdout: string): string | null {
  const start = stdout.lastIndexOf(START_MARKER);
  if (start < 0) {
    return null;
  }
  const from = start + START_MARKER.length;
  const end  = stdout.indexOf(END_MARKER, from);
  return end < 0 ? null : stdout.slice(from, end);
}

function snippet(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > SNIPPET_LENGTH ? `${t.slice(0, SNIPPET_LENGTH)}...` : t;
}

/** Absolute directories only, in order, deduplicated. `dropped` names what was refused and why. */
export function sanitizeEntries(raw: string): { entries: string[]; dropped: string[] } {
  const entries: string[] = [];
  const dropped: string[] = [];
  for (const e of raw.split(':')) {
    if (e === '') {
      // An empty entry means "the current directory": never wanted in a daemon, and very common (trailing colon).
      continue;
    }
    if (!e.startsWith('/') || /[\x00-\x1f\x7f]/.test(e)) {
      dropped.push(e.length > 60 ? `${e.slice(0, 60)}...` : e);
      continue;
    }
    if (e.length > MAX_ENTRY_LENGTH) {
      dropped.push(`${e.slice(0, 60)}... (${e.length} characters)`);
      continue;
    }
    if (!entries.includes(e)) {
      entries.push(e);
    }
  }
  return { entries, dropped };
}

export function mergeMacPath(nodeBinDir: string, userEntries: readonly string[]): string[] {
  const merged: string[] = [nodeBinDir];
  for (const e of [...userEntries, ...LEGACY_MAC_PATH]) {
    if (!merged.includes(e)) {
      merged.push(e);
    }
  }
  return merged;
}

function defaultEntries(home: string): string[] {
  return [path.posix.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin'];
}

/** What the plist PATH will be, and what the user must be told. Never throws. */
export function planMacPath(deps: MacPathDeps): MacPathPlan {
  const warnings: string[] = [];
  const defaultShell = deps.defaultShell ?? DEFAULT_MAC_SHELL;
  const entryName    = deps.entryName ?? 'plist';
  const rcFiles      = deps.rcFiles ?? '~/.zshrc or ~/.zprofile';

  let shell = defaultShell;
  if (deps.shellEnv && path.posix.isAbsolute(deps.shellEnv) && deps.isExecutableFile(deps.shellEnv)) {
    shell = deps.shellEnv;
  } else {
    warnings.push(
      deps.shellEnv
        ? `$SHELL is "${deps.shellEnv}", which is not an absolute path to an executable file; the PATH was read from ${defaultShell} instead. Fix: check "echo $SHELL" in a terminal.`
        : `$SHELL is not set for the daemon; the PATH was read from ${defaultShell}. Fix: if your login shell is not ${path.posix.basename(defaultShell)}, start the daemon from a terminal ("orch restart") so it sees $SHELL.`,
    );
  }

  const fallback = (why: string): MacPathPlan => {
    const entries = mergeMacPath(deps.nodeBinDir, deps.fallbackEntries ?? defaultEntries(deps.home));
    warnings.push(
      `could not read the PATH of your login shell (${why}). The start-at-login entry uses a default PATH instead: ${entries.join(':')}. `
      + `Jobs run from a login-started daemon will not find tools installed elsewhere (e.g. under ~/.local/bin or ~/.cargo/bin). `
      + `Fix: make \`${shell} -l -i -c 'echo $PATH'\` run cleanly in under ${SHELL_CAPTURE_TIMEOUT_MS / 1000}s (a slow or blocking command in ${rcFiles} is the usual cause), then run \`orch restart\` to rewrite the ${entryName}.`,
    );
    return { entries, warnings, captured: false };
  };

  // PATH is deliberately not inherited: the daemon's own PATH is the previous plist's, so passing it
  // would make the old node directory immortal. A login shell rebuilds a clean one (path_helper).
  const shellEnv: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TERM: 'dumb' };
  for (const k of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL']) {
    const v = deps.env[k];
    if (v !== undefined) {
      shellEnv[k] = v;
    }
  }

  let result: ShellRunResult;
  try {
    // Separate printf arguments, not one string: "$PATH__ORCH..." would be read as another variable, and fish has no ${}.
    result = deps.runShell(
      shell,
      ['-l', '-i', '-c', `printf '%s%s%s' ${START_MARKER} "$PATH" ${END_MARKER}`],
      shellEnv,
      SHELL_CAPTURE_TIMEOUT_MS,
    );
  } catch (e) {
    return fallback(`${shell} could not be run: ${getErrorMessage(e)}`);
  }

  if (result.timedOut) {
    return fallback(`${shell} did not answer within ${SHELL_CAPTURE_TIMEOUT_MS / 1000}s${result.stderr ? `; stderr: ${snippet(result.stderr)}` : ''}`);
  }
  if (result.error) {
    return fallback(`${shell} could not be run: ${result.error}`);
  }
  if (result.status !== 0) {
    return fallback(`${shell} exited with ${result.status}${result.stderr ? `; stderr: ${snippet(result.stderr)}` : ''}`);
  }
  const marked = extractMarkedPath(result.stdout);
  if (marked === null) {
    return fallback(`${shell} printed no PATH between the markers${result.stderr ? `; stderr: ${snippet(result.stderr)}` : ''}`);
  }

  const { entries: user, dropped } = sanitizeEntries(marked);
  if (user.length === 0) {
    return fallback(`${shell} printed a PATH without any absolute directory (got "${snippet(marked)}")`);
  }
  if (dropped.length > 0) {
    warnings.push(`ignored ${dropped.length} PATH entr${dropped.length === 1 ? 'y' : 'ies'} of your login shell that are not usable absolute directories: ${dropped.join(', ')}. Fix: remove them from your shell rc files if unintended.`);
  }
  if (user.length > MAX_ENTRIES) {
    warnings.push(`your login shell PATH has ${user.length} entries; only the first ${MAX_ENTRIES} are kept.`);
  }
  return { entries: mergeMacPath(deps.nodeBinDir, user.slice(0, MAX_ENTRIES)), warnings, captured: true };
}
