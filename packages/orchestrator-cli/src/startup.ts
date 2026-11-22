import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';
import { getErrorMessage } from './fsUtil.js';
import { findLauncherBinary, findDaemonEntry, findWatchdogEntry, launcherToRun } from './platform-binary.js';
import {
  BOOTSTRAP_FILE, BOOTSTRAP_SOURCE, START_VBS_FILE, bootstrapArgs, buildRunValue, buildStartVbs, decodeVbs, encodeVbs,
  parseRunValue, parseStartVbs, removeStartFiles, writeIfChanged,
} from './start-bootstrap.js';
import {
  planMacPath, mergeMacPath, realShellRunner, realIsExecutableFile,
  type MacPathDeps,
} from './login-shell-path.js';
import { ensureBundleLink, planBundleLink } from './bundle-link.js';
import { LAUNCHER_BUNDLE_SPEC, nodeDirOnPath } from './launcher-bundle.js';

const REG_KEY           = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LAUNCH_AGENT_LABEL = 'com.wadeck.orchestrator';
const SYSTEMD_UNIT_NAME  = 'orchestrator.service';

export function buildRegValueName(configDir: string): string {
  return `Orchestrator (${configDir})`;
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Verifies the entry we are about to register will actually resolve at login.
 * Returns an actionable error message, or null when the target is sound.
 * Without this a broken entry is written silently and only fails at the next login.
 *
 * The launcher finds its own bundle: `nodeScript` in ci/launcher.config.json is the package
 * specifier @wadeck-app/orchestrator-cli/dist/orchestrator.cjs, which the SDK resolves by
 * walking up node_modules. So there is nothing here that depends on whether npm hoisted or
 * nested the platform package, and no relative path to keep in sync.
 */
function validateStartupTarget(kind: EntryKind = 'launcher', watchdog: string | null = null): string | null {
  if (kind === 'watchdog') {
    return watchdog === null
      ? `start-at-login cannot be registered: dist/orchestrator-watchdog.cjs was not found next to ${__dirname}. `
        + 'Re-install with: npm install -g @wadeck-app/orchestrator-cli'
      : null;
  }
  if (!findLauncherBinary()) {
    // Registering node + the bundle would start a daemon with no supervisor, so nothing
    // would restart it after an update. Refuse rather than register a crippled entry.
    return 'start-at-login cannot be registered: the Go launcher binary was not found, and it '
      + 'is what supervises the daemon and restarts it after an update. Re-install with: '
      + 'npm install -g @wadeck-app/orchestrator-cli';
  }
  if (!findDaemonEntry()) {
    return `start-at-login cannot be registered: no daemon bundle next to ${__dirname}. `
      + 'Re-install with: npm install -g @wadeck-app/orchestrator-cli';
  }
  return null;
}

/**
 * Both builders assume validateStartupTarget() already passed.
 *
 * The registered path is the staged copy, never the one inside node_modules: an entry pointing into
 * node_modules would start the launcher from a directory npm has to move aside on every update, and
 * a running image there is what makes that move fail.
 */
export function buildWindowsCommand(configDir: string): string {
  const launcher = launcherToRun(configDir);
  if (!launcher) {
    throw new Error('buildWindowsCommand: no launcher binary');
  }
  return `${cmdQuote(launcher)} ${cmdQuote(configDir)}`;
}

/**
 * What the login entry starts. `watchdog`: node runs `<configDir>/orchestrator-start.cjs`, which finds the installed watchdog at
 * every login (start-bootstrap.ts). `launcher`: the Go launcher, only for an install that has no watchdog (kept one release).
 */
export type EntryKind = 'watchdog' | 'launcher';

export function buildMacArgs(configDir: string): string[] {
  const launcher = launcherToRun(configDir);
  if (!launcher) {
    throw new Error('buildMacArgs: no launcher binary');
  }
  return [launcher, configDir];
}

/**
 * Seams for tests and nothing else: production calls pass none. They let the macOS and Windows
 * branches run on any host without touching the real ~/Library/LaunchAgents, launchctl, the
 * registry or the user's shell.
 */
export interface StartupDeps {
  platform?: NodeJS.Platform;
  plistPath?: string;
  exec?: typeof execFileSync;
  macPath?: Partial<MacPathDeps>;
  /** Replaces buildMacArgs / buildWindowsCommand (both need the Go launcher, absent on CI). */
  programArguments?: string[];
  windowsCommand?: string;
  validateTarget?: () => string | null;
  /** Force what the entry starts (default: the watchdog when this install has one, else the Go launcher). */
  entryKind?: EntryKind;
  /** The node baked in the login entry (default: process.execPath). */
  nodePath?: string;
  /** This install's dist/orchestrator-watchdog.cjs, or null for none (default: findWatchdogEntry()). */
  watchdogEntry?: string | null;
  /** Linux: where the systemd user unit lives (default: $XDG_CONFIG_HOME or ~/.config, then systemd/user). */
  unitPath?: string;
  /** Linux: the daemon bundle written as LAUNCHER_BUNDLE_OVERRIDE (null: none). Default: findDaemonEntry(). */
  daemonEntry?: string | null;
  /** Linux: how the unit PATH is captured (same mechanism as macOS; see planMacPath). */
  linuxPath?: Partial<MacPathDeps>;
}

function macPlistPath(): string {
  // violations-suppress: shared/no-out-of-repo-path launchd only reads per-user agents from ~/Library/LaunchAgents; the location is macOS's, not ours
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * @param pathEntries the PATH of the daemon, in order (see planMacPath). Without it only the
 *   historical fixed list is written, which cannot find anything under ~/.local/bin.
 */
export function buildMacPlist(
  programArguments: string[], configDir: string, pathEntries?: readonly string[], opts: { bundle?: string | null } = {},
): string {
  const argsXml    = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const logDir     = xmlEscape(path.join(configDir, 'logs'));
  const envPath    = xmlEscape((pathEntries ?? mergeMacPath(path.dirname(process.execPath), [])).join(':'));
  // launchd can inject environment variables, so on macOS the launcher is handed an absolute
  // bundle path and never has to resolve it relative to its own directory. That is what makes
  // start-at-login here independent of whether npm hoisted or nested the platform package.
  // The watchdog entry passes null: a fixed bundle would outlive an `nvm use` and defeat the bootstrap's own lookup.
  const bundle = opts.bundle !== undefined ? opts.bundle : findDaemonEntry();
  const bundleEnv = bundle
    ? `\n    <key>LAUNCHER_BUNDLE_OVERRIDE</key>\n    <string>${xmlEscape(bundle)}</string>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
    <key>ORCH_CONFIG_DIR</key>
    <string>${xmlEscape(configDir)}</string>${bundleEnv}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logDir}/launchd.log</string>
  <key>StandardErrorPath</key>
  <string>${logDir}/launchd.log</string>
</dict>
</plist>
`;
}

// ---- Linux: a systemd USER unit ------------------------------------------------------------------

/**
 * ~/.config/systemd/user/orchestrator.service, or under $XDG_CONFIG_HOME when it is an absolute
 * path (an empty or relative value is ignored, as the XDG spec requires).
 */
export function systemdUnitPath(env: NodeJS.ProcessEnv, home: string): string {
  const xdg  = env['XDG_CONFIG_HOME'];
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.config');
  return path.join(base, 'systemd', 'user', SYSTEMD_UNIT_NAME);
}

function defaultUnitPath(): string {
  // violations-suppress: shared/no-out-of-repo-path systemd only reads user units from $XDG_CONFIG_HOME/systemd/user; the location is systemd's, not ours
  return systemdUnitPath(process.env, os.homedir());
}

/** The link `systemctl --user enable` creates for WantedBy=default.target, next to the unit. */
function systemdWantsPath(unitPath: string): string {
  return path.join(path.dirname(unitPath), 'default.target.wants', SYSTEMD_UNIT_NAME);
}

/**
 * One double-quoted systemd word. Inside quotes systemd reads C escapes (\\ and \"), and expands
 * % specifiers everywhere (so % becomes %%). In ExecStart a $ starts a variable, so it becomes $$;
 * Environment= values are not expanded, there a $ stays as is. A control character cannot be
 * represented safely, so it is refused rather than written.
 */
export function systemdQuote(value: string, opts: { exec: boolean }): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`systemd unit value contains a control character: ${JSON.stringify(value)}`);
  }
  let v = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');
  if (opts.exec) {
    v = v.replace(/\$/g, '$$$$');
  }
  return `"${v}"`;
}

function systemdEnvLine(key: string, value: string): string {
  return `Environment=${systemdQuote(`${key}=${value}`, { exec: false })}`;
}

/**
 * Restart=no because the launcher already supervises the daemon and restarts it: a second restarter
 * would fight it on `orch stop`. LAUNCHER_BUNDLE_OVERRIDE is set like in the macOS plist, so the
 * launcher never has to find its bundle relative to itself. The unit declares what runs at login;
 * it is never started by enabling it.
 */
export function buildSystemdUnit(
  programArguments: string[], configDir: string, pathEntries: readonly string[], bundle: string | null,
): string {
  return [
    '# Written by `orch install` and rewritten at every daemon start: do not edit.',
    '[Unit]',
    'Description=Orchestrator daemon (launcher and supervisor)',
    '',
    '[Service]',
    'Type=simple',
    // The launcher supervises the daemon and restarts it itself: systemd must not add a second restarter.
    'Restart=no',
    // A stop ends the launcher and so the unit. With the default KillMode (control-group) systemd would then kill every process
    // of the unit, the job supervisors and the jobs with them, which a stop must leave running (docs/daemon-config.md).
    'KillMode=process',
    `ExecStart=${programArguments.map((a) => systemdQuote(a, { exec: true })).join(' ')}`,
    systemdEnvLine('PATH', pathEntries.join(':')),
    systemdEnvLine('ORCH_CONFIG_DIR', configDir),
    ...(bundle ? [systemdEnvLine('LAUNCHER_BUNDLE_OVERRIDE', bundle)] : []),
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function execDetail(e: unknown): string {
  const stderr = typeof e === 'object' && e !== null ? Reflect.get(e, 'stderr') : undefined;
  const text   = stderr ? String(stderr).trim() : '';
  return text || getErrorMessage(e).trim();
}

/** Turns a failed `systemctl --user <verb>` into what is wrong and what to do. `state` says what was done before it failed. */
function systemctlFailure(e: unknown, verb: string, state: string): string {
  const raw = execDetail(e);
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
    return `systemctl was not found on PATH: start-at-login on Linux needs systemd. ${state} `
      + 'Install systemd, or start the daemon yourself with `orch start`.';
  }
  if (/Failed to connect to (user scope )?bus|not been booted with systemd|XDG_RUNTIME_DIR|No medium found/i.test(raw)) {
    return `\`systemctl --user ${verb}\` found no systemd user session (${raw}). ${state} `
      + 'Run this from a login session (a desktop or ssh login that has a systemd user manager). For a headless server or '
      + 'container, the user must linger: run `sudo loginctl enable-linger $USER`, then run `orch install` again.';
  }
  return `\`systemctl --user ${verb}\` failed: ${raw}. ${state}`;
}

interface EntryPlan {
  kind: EntryKind;
  /** This install's watchdog bundle (the hint written in the entry), null when it has none. */
  watchdog: string | null;
  warnings: string[];
}

/**
 * The watchdog when this install has one, else the Go launcher with a warning. The test seams that hand over launcher-shaped
 * arguments (programArguments, windowsCommand) keep meaning the launcher.
 */
function planEntry(deps: StartupDeps): EntryPlan {
  const watchdog = deps.watchdogEntry !== undefined ? deps.watchdogEntry : findWatchdogEntry();
  if (deps.entryKind !== undefined) {
    return { kind: deps.entryKind, watchdog, warnings: [] };
  }
  if (deps.programArguments !== undefined || deps.windowsCommand !== undefined) {
    return { kind: 'launcher', watchdog, warnings: [] };
  }
  if (watchdog !== null) {
    return { kind: 'watchdog', watchdog, warnings: [] };
  }
  return {
    kind: 'launcher', watchdog,
    warnings: [`this install has no dist/orchestrator-watchdog.cjs next to ${__dirname}: start-at-login runs the Go launcher (fallback). Re-install with: npm install -g @wadeck-app/orchestrator-cli`],
  };
}

/** Writes the bootstrap (only when its text changed) and returns the arguments of the login command. */
function watchdogEntryArgs(configDir: string, plan: EntryPlan, deps: StartupDeps): string[] {
  writeIfChanged(path.join(configDir, BOOTSTRAP_FILE), BOOTSTRAP_SOURCE);
  return bootstrapArgs({ node: deps.nodePath ?? process.execPath, configDir, hint: plan.watchdog });
}

/**
 * Windows: writes the bootstrap and the hidden-start script into the config dir (never into the npm package folder, which npm
 * replaces), and returns the Run value. Both files exist before the registry value names them.
 */
function writeWindowsWatchdogEntry(configDir: string, plan: EntryPlan, deps: StartupDeps): string {
  const args = watchdogEntryArgs(configDir, plan, deps);
  const vbs  = path.join(configDir, START_VBS_FILE);
  writeIfChanged(vbs, encodeVbs(buildStartVbs(args, configDir)));
  return buildRunValue(vbs);
}

function enableSystemd(configDir: string, deps: StartupDeps, exec: typeof execFileSync, entry: EntryPlan): StartupResult {
  const unitPath = deps.unitPath ?? defaultUnitPath();
  const diag: string[] = [];
  let warnings: string[] = [];

  try {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const args = deps.programArguments ?? (entry.kind === 'watchdog' ? watchdogEntryArgs(configDir, entry, deps) : buildMacArgs(configDir));
    // Same capture as macOS: a systemd user manager does not read ~/.bashrc or ~/.profile either,
    // and its own PATH is minimal, so `node` and the tools of the jobs would not be found.
    // violations-suppress: shared/no-out-of-repo-path the user's home is where ~/.local/bin lives; it is the point of the default list
    const home = deps.linuxPath?.home ?? os.homedir();
    const plan = planMacPath({
      runShell:         realShellRunner,
      shellEnv:         process.env.SHELL,
      isExecutableFile: realIsExecutableFile,
      home,
      nodeBinDir:       path.dirname(process.execPath),
      env:              process.env,
      defaultShell:     '/bin/sh',
      fallbackEntries:  [path.posix.join(home, '.local', 'bin')],
      entryName:        'unit file',
      rcFiles:          "~/.bashrc, ~/.profile or your shell's equivalent",
      ...deps.linuxPath,
    });
    warnings = [...entry.warnings, ...plan.warnings];
    diag.push(plan.captured ? 'path=login-shell' : 'path=default');
    // The watchdog entry carries no fixed daemon bundle: the watchdog finds it next to itself at every start.
    const bundle = entry.kind === 'watchdog' ? null : deps.daemonEntry !== undefined ? deps.daemonEntry : findDaemonEntry();
    const unit   = buildSystemdUnit(args, configDir, plan.entries, bundle);
    const tmp    = unitPath + '.tmp';
    fs.writeFileSync(tmp, unit, 'utf8');
    fs.renameSync(tmp, unitPath);
    diag.push('unit=written', `entry=${entry.kind}`);
  } catch (e) { return { ok: false, error: `Failed to write the systemd unit ${unitPath}: ${(e as Error).message}` }; }

  const written = `The unit was written to ${unitPath} but is not enabled.`;
  const run = (...argv: string[]): string | null => {
    try { exec('systemctl', ['--user', ...argv], { stdio: 'pipe', windowsHide: true }); return null; }
    catch (e) { return systemctlFailure(e, argv.join(' '), written); }
  };
  // Not --now: the daemon may already be running, and enabling must not start a second one.
  const failed = run('daemon-reload') ?? run('enable', SYSTEMD_UNIT_NAME);
  if (failed) {
    return { ok: false, error: failed };
  }
  diag.push('daemon-reload=ok', 'enable=ok');
  diag.push('it starts at your login; to start at boot with no login the user must linger (`loginctl enable-linger`, done by `orch install` itself)');
  return warnings.length > 0
    ? { ok: true, detail: diag.join(' | '), warnings }
    : { ok: true, detail: diag.join(' | ') };
}

function disableSystemd(deps: StartupDeps, exec: typeof execFileSync): StartupResult {
  const unitPath = deps.unitPath ?? defaultUnitPath();
  if (!fs.existsSync(unitPath) && !fs.existsSync(systemdWantsPath(unitPath))) {
    return { ok: true, detail: 'already off: no systemd unit' };
  }
  const state = `The unit file ${unitPath} was removed.`;
  let failure: string | null = null;
  try { exec('systemctl', ['--user', 'disable', SYSTEMD_UNIT_NAME], { stdio: 'pipe', windowsHide: true }); }
  catch (e) { failure = systemctlFailure(e, `disable ${SYSTEMD_UNIT_NAME}`, state); }

  // Removed even when `disable` failed: without the unit file isStartupEnabled reads false, and a
  // dangling link in default.target.wants is ignored by systemd.
  try { fs.rmSync(unitPath, { force: true }); }
  catch (e) { return { ok: false, error: `Failed to remove ${unitPath}: ${(e as Error).message}${failure ? ` Also: ${failure}` : ''}` }; }

  if (failure) {
    return { ok: false, error: failure };
  }
  try { exec('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe', windowsHide: true }); }
  catch (e) { return { ok: false, error: systemctlFailure(e, 'daemon-reload', `${state} Start-at-login is off.`) }; }
  return { ok: true, detail: 'disable=ok | unit=removed | daemon-reload=ok' };
}

// ---- Is the registered entry still usable, and is it this install's? ----------------------------------

export interface StartupEntryReport {
  /**
   * absent: nothing registered for this config dir. broken: it names a path that is gone, or a file of ours that is damaged.
   * outdated: it works but starts the Go launcher while this install has the Node watchdog. drift: it works but names another install.
   */
  state: 'absent' | 'ok' | 'broken' | 'outdated' | 'drift';
  problems: string[];
}

export interface InspectDeps extends StartupDeps {
  /** Reads a file of the entry (the bootstrap, the hidden-start script). Default: fs.readFileSync. */
  readFile?: (p: string) => Buffer;
  isFile?: (p: string) => boolean;
  realpath?: (p: string) => string;
  /** The directory of the node this process runs (default: dirname(process.execPath)). */
  nodeBinDir?: string;
  /** Windows: what is wrong with the node_modules link of the staged launcher, or null (default: bundle-link.ts against this install). Tests set it. */
  bundleLinkProblem?: (launcher: string) => string | null;
}

/** Windows: the staged launcher has to be shown the global node_modules when it cannot find the bundle itself (bundle-link.ts). */
function defaultBundleLinkProblem(launcher: string): string | null {
  const daemon = findDaemonEntry();
  const plan = daemon === null ? null : planBundleLink({ daemonPath: daemon, spec: LAUNCHER_BUNDLE_SPEC, nodeDir: nodeDirOnPath(process.env) });
  if (plan === null) {
    return null;
  }
  const link = path.join(path.dirname(launcher), 'node_modules');
  try {
    return fs.realpathSync(link) === fs.realpathSync(plan.modulesDir) ? null : `${link} leads to ${fs.realpathSync(link)}, not to ${plan.modulesDir}`;
  } catch {
    return `${link} is missing: the launcher cannot find the daemon bundle in ${plan.modulesDir}`;
  }
}

const defaultIsFile = (p: string): boolean => {
  try { return fs.statSync(p).isFile(); } catch { return false; }
};

function xmlUnescape(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

/** Reverses systemdQuote for the text between the quotes. */
function systemdUnquote(s: string, exec: boolean): string {
  const v = s.replace(/\\(.)/g, '$1').replace(/%%/g, '%');
  return exec ? v.replace(/\$\$/g, '$') : v;
}

interface EntryFields {
  /** First word of the command: the Go launcher, or node for a watchdog entry. */
  launcher: string | null;
  /** Every word of the command (macOS, Linux); for a Windows watchdog entry see vbs. */
  args: string[];
  bundle: string | null;
  /** The directories of the PATH the daemon will get (null: the entry carries none, the launcher uses the login's). */
  pathDirs: string[] | null;
  /** Windows, Run value naming a hidden-start script: its path (null: the value is something else, e.g. the Go launcher's). */
  vbsPath?: string | null;
}

/** The entry starts the bootstrap, whatever the platform: node, orchestrator-start.cjs, the config dir. */
function isBootstrapArgs(args: readonly string[]): boolean {
  return args.length >= 3 && path.posix.basename((args[1] ?? '').replace(/\\/g, '/')) === BOOTSTRAP_FILE;
}

function readSystemdFields(text: string): EntryFields {
  const env = new Map<string, string>();
  for (const m of text.matchAll(/^Environment="((?:[^"\\]|\\.)*)"$/gm)) {
    const decoded = systemdUnquote(m[1] ?? '', false);
    const eq = decoded.indexOf('=');
    if (eq > 0) { env.set(decoded.slice(0, eq), decoded.slice(eq + 1)); }
  }
  const exec = /^ExecStart=(.*)$/m.exec(text);
  const args = [...(exec?.[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((w) => systemdUnquote(w[1] ?? '', true));
  const p = env.get('PATH');
  return {
    launcher: args[0] ?? null,
    args,
    bundle:   env.get('LAUNCHER_BUNDLE_OVERRIDE') ?? null,
    pathDirs: p === undefined ? null : p.split(':').filter(d => d !== ''),
  };
}

function readPlistFields(text: string): EntryFields {
  const after = (key: string): string | null => {
    const m = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text);
    return m ? xmlUnescape(m[1] ?? '') : null;
  };
  const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  const args = [...(array?.[1] ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((w) => xmlUnescape(w[1] ?? ''));
  const p = after('PATH');
  return {
    launcher: args[0] ?? null,
    args,
    bundle:   after('LAUNCHER_BUNDLE_OVERRIDE'),
    pathDirs: p === null ? null : p.split(':').filter(d => d !== ''),
  };
}

/**
 * Reads the registered entry back and says whether it still resolves at login (it names no path that is gone) and whether it
 * is this install's. `broken` is what a node or npm prefix change leaves behind: the daemon would not start at the next login,
 * with the reason only in a launcher log. `drift` is an entry that works but starts another install than the one running
 * this command (a cron job or an agent under another node); it is reported, never rewritten, since two such callers would
 * rewrite it back and forth. Never throws.
 */
export function inspectStartupEntry(configDir: string, deps: InspectDeps = {}): StartupEntryReport {
  const platform = deps.platform ?? process.platform;
  const isFile   = deps.isFile ?? defaultIsFile;
  const realpath = deps.realpath ?? ((p: string) => fs.realpathSync(p));
  const same = (a: string, b: string): boolean => {
    try { return realpath(a) === realpath(b); } catch { return a === b; }
  };
  if (!isStartupEnabled(configDir, deps)) {
    return { state: 'absent', problems: [] };
  }
  let fields: EntryFields;
  try {
    if (platform === 'linux') {
      fields = readSystemdFields(fs.readFileSync(deps.unitPath ?? defaultUnitPath(), 'utf8'));
    } else if (platform === 'darwin') {
      fields = readPlistFields(fs.readFileSync(deps.plistPath ?? macPlistPath(), 'utf8'));
    } else if (platform === 'win32') {
      const exec = deps.exec ?? execFileSync;
      const out  = String(exec('reg', ['query', REG_KEY, '/v', buildRegValueName(configDir)],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
      const vbsPath = parseRunValue(/REG_SZ\s+(.*?)\s*$/m.exec(out)?.[1] ?? '');
      const m = /REG_SZ\s+"((?:[^"]|"")*)"/.exec(out);
      fields = {
        launcher: vbsPath === null && m ? (m[1] ?? '').replace(/""/g, '"') : null,
        args: [], bundle: null, pathDirs: null, vbsPath,
      };
    } else {
      return { state: 'absent', problems: [] };
    }
  } catch (e) {
    return { state: 'broken', problems: [`the registered start-at-login entry cannot be read (${getErrorMessage(e)})`] };
  }

  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p));
  const currentWatchdog = deps.watchdogEntry !== undefined ? deps.watchdogEntry : findWatchdogEntry();
  // The entry's paths are the target platform's, whatever host reads them.
  const pathLib  = platform === 'win32' ? path.win32 : path.posix;
  const problems: string[] = [];

  // Windows: the Run value names the hidden-start script, and the command is in it.
  let words = fields.args;
  if (fields.vbsPath !== undefined && fields.vbsPath !== null) {
    words = [];
    try {
      const text = decodeVbs(readFile(fields.vbsPath));
      const parsed = parseStartVbs(text);
      if (parsed === null) {
        problems.push(`the start-at-login script ${fields.vbsPath} does not start anything (damaged): run orch install`);
      } else {
        words = parsed;
        if (isBootstrapArgs(parsed) && text !== buildStartVbs(parsed, configDir)) {
          problems.push(`the start-at-login script ${fields.vbsPath} is not the one of this version (damaged or edited)`);
        }
      }
    } catch (e) {
      problems.push(`the start-at-login script ${fields.vbsPath} cannot be read (${getErrorMessage(e)})`);
    }
  }
  const watchdogEntry = isBootstrapArgs(words);
  let entryNodeDir: string | null = null;

  if (watchdogEntry) {
    const [node = '', bootstrap = ''] = words;
    entryNodeDir = pathLib.dirname(node);
    if (!isFile(node)) {
      problems.push(`the node ${node} is gone`);
    }
    if (!isFile(bootstrap)) {
      problems.push(`the start-at-login bootstrap ${bootstrap} is missing`);
    } else {
      let text: string | null = null;
      try { text = readFile(bootstrap).toString('utf8'); } catch (e) { problems.push(`the start-at-login bootstrap ${bootstrap} cannot be read (${getErrorMessage(e)})`); }
      if (text !== null && text !== BOOTSTRAP_SOURCE) {
        problems.push(`the start-at-login bootstrap ${bootstrap} is not the one of this version (damaged or written by another version)`);
      }
    }
    if (currentWatchdog === null) {
      // The reverse of the migration: an older package was installed under an entry for the watchdog. Re-registering names the Go launcher again.
      problems.push('the entry starts the Node watchdog, but this install has no dist/orchestrator-watchdog.cjs (an older version was installed?): it will start the Go launcher instead');
    }
  } else if (fields.vbsPath !== undefined && fields.vbsPath !== null) {
    if (problems.length === 0) {
      problems.push(`the start-at-login script ${fields.vbsPath} does not run the bootstrap: run orch install`);
    }
  } else {
    if (fields.launcher === null) {
      problems.push('the registered entry names no launcher');
    } else if (!isFile(fields.launcher)) {
      problems.push(`the launcher ${fields.launcher} is gone`);
    }
    if (fields.bundle !== null && !isFile(fields.bundle)) {
      problems.push(`the daemon bundle ${fields.bundle} is gone`);
    }
    if (platform === 'win32' && fields.launcher !== null && isFile(fields.launcher)) {
      const linkProblem = (deps.bundleLinkProblem ?? defaultBundleLinkProblem)(fields.launcher);
      if (linkProblem !== null) {
        problems.push(linkProblem);
      }
    }
  }
  const nodeExe  = pathLib.join;
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const nodeDir  = fields.pathDirs?.find(d => isFile(nodeExe(d, nodeName))) ?? null;
  if (fields.pathDirs !== null && nodeDir === null) {
    problems.push(`no node in the PATH of the entry (${fields.pathDirs.join(':')})`);
  }
  if (problems.length > 0) {
    return { state: 'broken', problems };
  }
  if (!watchdogEntry && currentWatchdog !== null) {
    return {
      state: 'outdated',
      problems: ['the entry still starts the Go launcher; this install starts at login through the Node watchdog (docs/watchdog.md)'],
    };
  }

  const drift: string[] = [];
  const currentBundle = deps.daemonEntry !== undefined ? deps.daemonEntry : findDaemonEntry();
  if (fields.bundle !== null && currentBundle && !same(fields.bundle, currentBundle)) {
    drift.push(`the entry starts the daemon bundle ${fields.bundle}, this orch runs from ${currentBundle}`);
  }
  const currentNodeDir = deps.nodeBinDir ?? path.dirname(process.execPath);
  const startedNodeDir = entryNodeDir ?? nodeDir;
  if (startedNodeDir !== null && !same(startedNodeDir, currentNodeDir)) {
    drift.push(`the entry starts the daemon under the node in ${startedNodeDir}, this orch runs under the node in ${currentNodeDir}`);
  }
  return drift.length > 0 ? { state: 'drift', problems: drift } : { state: 'ok', problems: [] };
}

/**
 * Re-registers the entry when (and only when) it is broken, with this install's paths. Returns the report, and the outcome of
 * the rewrite when there was one. A drift is left alone on purpose, see inspectStartupEntry.
 */
export function repairStartupEntry(configDir: string, deps: InspectDeps = {}): { report: StartupEntryReport; repair: StartupResult | null } {
  const report = inspectStartupEntry(configDir, deps);
  if (report.state !== 'broken' && report.state !== 'outdated') {
    return { report, repair: null };
  }
  return { report, repair: enableStartup(configDir, deps) };
}

export interface LingerDeps {
  platform?: NodeJS.Platform;
  exec?: typeof execFileSync;
  /** The user to enable lingering for (default: the account running orch, which is not $USER under sudo). */
  user?: string;
  /** Whether a person can type a password: sudo is only tried then, since it would wait on a prompt nobody sees. */
  interactive?: boolean;
}

function lingerUser(deps: LingerDeps): string {
  return deps.user ?? os.userInfo().username;
}

/** Whether the user lingers (`loginctl show-user`). Throws when loginctl cannot answer. */
function isLingering(exec: typeof execFileSync, user: string): boolean {
  const out = exec('loginctl', ['show-user', user, '--property=Linger', '--value'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return String(out).trim() === 'yes';
}

/**
 * Linux: lets the user's systemd manager (and so the daemon) start at boot with no login. Tried as the user first (polkit often
 * allows it), then through sudo with the terminal handed over so a password can be typed. Called by `orch install` only: the
 * daemon refreshes the unit at every start and has no terminal. Never throws; a failure carries the exact command to run.
 */
export function ensureLinger(deps: LingerDeps = {}): StartupResult {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return { ok: true, detail: 'lingering: not applicable on this platform' };
  }
  const exec = deps.exec ?? execFileSync;
  const user = lingerUser(deps);
  const byHand = `sudo loginctl enable-linger ${user}`;
  try {
    if (isLingering(exec, user)) {
      return { ok: true, detail: 'lingering already enabled: starts at boot with no login' };
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `loginctl was not found on PATH: starting at boot with no login needs systemd. Run \`${byHand}\` once it is installed.` };
    }
    // Unreadable is not a verdict: enabling below either works or says why not.
  }
  let plainFailure: string;
  try {
    exec('loginctl', ['enable-linger', user], { stdio: 'pipe', windowsHide: true });
    return { ok: true, detail: 'lingering enabled: starts at boot with no login' };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `loginctl was not found on PATH: starting at boot with no login needs systemd. Run \`${byHand}\` once it is installed.` };
    }
    plainFailure = execDetail(e);
  }
  if (!(deps.interactive ?? false)) {
    return { ok: false, error: `Lingering could not be enabled for ${user} (${plainFailure}) and there is no terminal to ask for a password: the daemon will start after a login only. Run \`${byHand}\`.` };
  }
  try {
    // Inherited stdio: sudo prompts on the terminal.
    exec('sudo', ['loginctl', 'enable-linger', user], { stdio: 'inherit', windowsHide: true });
    return { ok: true, detail: 'lingering enabled through sudo: starts at boot with no login' };
  } catch (e) {
    return { ok: false, error: `Lingering could not be enabled for ${user}: as the user: ${plainFailure}; through sudo: ${execDetail(e)}. The daemon will start after a login only. Run \`${byHand}\`.` };
  }
}

/**
 * What the daemon says at its start on Linux when the start-at-boot setup is incomplete (null: nothing to say). Silence about a
 * missing registration or lingering looks like success until the machine reboots.
 */
export function lingerAdvice(deps: LingerDeps & { registered: boolean }): string | null {
  if ((deps.platform ?? process.platform) !== 'linux') {
    return null;
  }
  if (!deps.registered) {
    return 'start-at-login is not registered: this daemon will not start after a reboot. Run `orch install`.';
  }
  const exec = deps.exec ?? execFileSync;
  const user = lingerUser(deps);
  try {
    if (isLingering(exec, user)) {
      return null;
    }
  } catch (e) {
    return `start-at-login is registered but lingering could not be read (${execDetail(e)}): whether the daemon starts at boot with no login is unknown. Check with \`loginctl show-user ${user} --property=Linger\`.`;
  }
  return `start-at-login is registered but ${user} does not linger: the daemon starts only after a login. Run \`orch install\` (it asks for sudo if needed), or \`sudo loginctl enable-linger ${user}\`.`;
}

export function enableStartup(configDir: string, deps: StartupDeps = {}): StartupResult {
  const platform = deps.platform ?? process.platform;
  const exec     = deps.exec ?? execFileSync;
  if (/[\r\n\x00]/.test(configDir)) {
    return { ok: false, error: 'configDir contains invalid characters' };
  }

  // Platform first: on a target with no start-at-login mechanism at all, reporting a missing
  // launcher would name a consequence instead of the actual reason.
  if (platform !== 'darwin' && platform !== 'win32' && platform !== 'linux') {
    return { ok: false, error: `Unsupported platform: ${platform}` };
  }

  const entry = planEntry(deps);
  const unusable = (deps.validateTarget ?? (() => validateStartupTarget(entry.kind, entry.watchdog)))();
  if (unusable) {
    return { ok: false, error: unusable };
  }

  if (platform === 'linux') {
    return enableSystemd(configDir, deps, exec, entry);
  }

  if (platform === 'darwin') {
    const plistPath = deps.plistPath ?? macPlistPath();
    const uid       = process.getuid?.() ?? 0;
    const target    = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
    const diag: string[] = [];
    let warnings: string[] = [];

    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      const args  = deps.programArguments ?? (entry.kind === 'watchdog' ? watchdogEntryArgs(configDir, entry, deps) : buildMacArgs(configDir));
      // Only here, only on darwin: the shell is read when the plist is written, never on Windows.
      const plan  = planMacPath({
        runShell:         realShellRunner,
        shellEnv:         process.env.SHELL,
        isExecutableFile: realIsExecutableFile,
        // violations-suppress: shared/no-out-of-repo-path the user's home is where ~/.local/bin lives; it is the point of the default list
        home:             os.homedir(),
        nodeBinDir:       path.dirname(process.execPath),
        env:              process.env,
        ...deps.macPath,
      });
      warnings = [...entry.warnings, ...plan.warnings];
      diag.push(plan.captured ? 'path=login-shell' : 'path=default');
      // No fixed daemon bundle in the watchdog entry (null): the watchdog finds it next to itself at every start.
      const plist = buildMacPlist(args, configDir, plan.entries, entry.kind === 'watchdog' ? { bundle: null } : {});
      const tmp   = plistPath + '.tmp';
      fs.writeFileSync(tmp, plist, 'utf8');
      fs.renameSync(tmp, plistPath);
      diag.push('plist=written', `entry=${entry.kind}`);
    } catch (e) { return { ok: false, error: `Failed to write plist: ${(e as Error).message}` }; }

    try { exec('launchctl', ['enable', target], { stdio: 'pipe', windowsHide: true }); diag.push('enable=ok'); }
    catch (e) { diag.push(`enable=failed(${(e as Error).message?.trim()})`); }

    return warnings.length > 0
      ? { ok: true, detail: diag.join(' | '), warnings }
      : { ok: true, detail: diag.join(' | ') };
  }

  if (platform === 'win32') {
    const valueName = buildRegValueName(configDir);
    let value: string;
    try {
      value = deps.windowsCommand ?? (entry.kind === 'watchdog' ? writeWindowsWatchdogEntry(configDir, entry, deps) : buildWindowsCommand(configDir));
    } catch (e) { return { ok: false, error: `Failed to write the start-at-login files in ${configDir}: ${getErrorMessage(e)}` }; }
    try {
      exec('reg', ['add', REG_KEY, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe', windowsHide: true });
    } catch (e) { return { ok: false, error: `reg.exe failed: ${(e as Error).message}` }; }
    const detail = `registry key set: ${REG_KEY}\\${valueName} | entry=${entry.kind}`;
    if (entry.kind === 'watchdog') {
      return entry.warnings.length > 0 ? { ok: true, detail, warnings: entry.warnings } : { ok: true, detail };
    }
    // The Run value cannot carry LAUNCHER_BUNDLE_OVERRIDE, so a launcher that cannot find the bundle by itself is shown where it is.
    // Said, not swallowed: without it the entry is written and the next login starts nothing.
    if (deps.windowsCommand === undefined) {
      try {
        const staged = launcherToRun(configDir);
        const daemon = findDaemonEntry();
        const plan = staged === null || daemon === null || !staged.startsWith(path.join(configDir, 'bin'))
          ? null
          : planBundleLink({ daemonPath: daemon, spec: LAUNCHER_BUNDLE_SPEC, nodeDir: nodeDirOnPath(process.env) });
        if (staged !== null && plan !== null) {
          const outcome = ensureBundleLink(path.dirname(staged), plan);
          return { ok: true, detail: `${detail} | bundle-link=${outcome} (${plan.modulesDir})`, ...(entry.warnings.length > 0 ? { warnings: entry.warnings } : {}) };
        }
      } catch (e) {
        return {
          ok: true, detail,
          warnings: [...entry.warnings, `the launcher may not find the daemon bundle at login: ${getErrorMessage(e)}`],
        };
      }
    }
    return entry.warnings.length > 0 ? { ok: true, detail, warnings: entry.warnings } : { ok: true, detail };
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

/**
 * The login entry of macOS (one LaunchAgent label) and Linux (one unit) is shared by every config dir of the user. When it
 * exists but names another config dir, disabling it from here would take the other instance's start at login away without
 * a word (a dev checkout with its own .dev-config is the case that happens). Returns the refusal, or null when there is no
 * entry or it is this config dir's.
 */
function foreignLoginEntry(platform: NodeJS.Platform, configDir: string, deps: StartupDeps): string | null {
  let entryPath: string;
  let ours: (text: string) => boolean;
  if (platform === 'darwin') {
    entryPath = deps.plistPath ?? macPlistPath();
    ours      = (text) => text.includes(`<string>${xmlEscape(configDir)}</string>`);
  } else if (platform === 'linux') {
    entryPath = deps.unitPath ?? defaultUnitPath();
    ours      = (text) => text.includes(`${systemdEnvLine('ORCH_CONFIG_DIR', configDir)}\n`);
  } else {
    return null;
  }
  let text: string;
  try {
    text = fs.readFileSync(entryPath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return `The start-at-login entry ${entryPath} cannot be read (${getErrorMessage(e)}), so it was not removed: it may belong to another config dir. Fix the permissions, or delete it by hand.`;
  }
  if (ours(text)) {
    return null;
  }
  return `The start-at-login entry ${entryPath} belongs to another config dir, so nothing was removed. `
    + 'Run orch uninstall with that config dir (set ORCH_CONFIG_DIR to it), or delete the entry by hand.';
}

function disableEntry(configDir: string, deps: StartupDeps): StartupResult {
  const platform = deps.platform ?? process.platform;
  const exec     = deps.exec ?? execFileSync;
  if (/[\r\n\x00]/.test(configDir)) {
    return { ok: false, error: 'configDir contains invalid characters' };
  }
  const foreign = foreignLoginEntry(platform, configDir, deps);
  if (foreign !== null) {
    return { ok: false, error: foreign };
  }
  if (platform === 'linux') {
    return disableSystemd(deps, exec);
  }
  if (platform === 'darwin') {
    const plistPath = deps.plistPath ?? macPlistPath();
    const uid       = process.getuid?.() ?? 0;
    const target    = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
    const diag: string[] = [];

    try { exec('launchctl', ['bootout', target],  { stdio: 'pipe', windowsHide: true }); diag.push('bootout=ok'); }
    catch (e) { diag.push(`bootout=skipped(${(e as Error).message?.trim()})`); }

    try { exec('launchctl', ['disable', target], { stdio: 'pipe', windowsHide: true }); diag.push('disable=ok'); }
    catch (e) { diag.push(`disable=failed(${(e as Error).message?.trim()})`); }

    try { fs.unlinkSync(plistPath); diag.push('plist=removed'); }
    catch { diag.push('plist=already-absent'); }

    return { ok: true, detail: diag.join(' | ') };
  }

  if (platform === 'win32') {
    const valueName = buildRegValueName(configDir);
    try { exec('reg', ['delete', REG_KEY, '/v', valueName, '/f'], { stdio: 'pipe', windowsHide: true }); }
    catch { /* already absent */ }
    return { ok: true, detail: `registry key removed: ${REG_KEY}\\${valueName}` };
  }

  return { ok: false, error: `Unsupported platform: ${platform}` };
}

/**
 * Removes the login entry, then the bootstrap and the hidden-start script of this config dir. An entry that belongs to another
 * config dir is refused before anything is touched (its files are not ours either).
 */
export function disableStartup(configDir: string, deps: StartupDeps = {}): StartupResult {
  const result = disableEntry(configDir, deps);
  const platform = deps.platform ?? process.platform;
  const known = platform === 'darwin' || platform === 'win32' || platform === 'linux';
  if (!known || /[\r\n\x00]/.test(configDir) || foreignLoginEntry(platform, configDir, deps) !== null) {
    return result;
  }
  try {
    const removed = removeStartFiles(configDir);
    return result.ok && removed.length > 0 ? { ...result, detail: `${result.detail} | removed ${removed.join(', ')}` } : result;
  } catch (e) {
    const error = `Failed to remove the start-at-login files in ${configDir}: ${getErrorMessage(e)}. Delete ${BOOTSTRAP_FILE} and ${START_VBS_FILE} there by hand.`;
    return { ok: false, error: result.ok ? error : `${result.error} Also: ${error}` };
  }
}

export function isStartupEnabled(configDir: string, deps: StartupDeps = {}): boolean {
  if ((deps.platform ?? process.platform) === 'darwin') {
    // The launchd label is a single global one, so the plist must also be checked to belong to
    // THIS configDir. Otherwise a second instance sees "enabled" and refreshStartupEntry, which
    // now runs on every daemon start, silently rewrites the plist to its own configDir and
    // steals the login entry from the first.
    try {
      return fs.readFileSync(deps.plistPath ?? macPlistPath(), 'utf8').includes(`<string>${xmlEscape(configDir)}</string>`);
    } catch { return false; }
  }
  if ((deps.platform ?? process.platform) === 'win32') {
    const valueName = buildRegValueName(configDir);
    try {
      // `reg query /v` exits non-zero when the value is absent, so reaching here means the
      // entry exists. Do NOT match on process.execPath: in launcher mode the recorded
      // command is the Go launcher, not node, which made this always report "disabled".
      const out = (deps.exec ?? execFileSync)('reg', ['query', REG_KEY, '/v', valueName],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return String(out).includes(valueName);
    } catch { return false; }
  }
  if ((deps.platform ?? process.platform) === 'linux') {
    // The filesystem, not `systemctl is-enabled`: that needs a reachable user bus, which a daemon
    // started from ssh or a container may lack, and a false here would make refreshStartupEntry skip
    // a stale unit in silence. `enable` creates this link for WantedBy=default.target. The unit must
    // also belong to THIS configDir (it is a single global unit, like the launchd label).
    try {
      const unitPath = deps.unitPath ?? defaultUnitPath();
      const unit     = fs.readFileSync(unitPath, 'utf8');
      fs.lstatSync(systemdWantsPath(unitPath));
      return unit.includes(`${systemdEnvLine('ORCH_CONFIG_DIR', configDir)}\n`);
    } catch { return false; }
  }
  return false;
}

/**
 * Rewrites an existing start-at-login entry so it points at the current install paths.
 * Called on daemon start: an nvm/node upgrade or an npm prefix change moves the launcher,
 * leaving a registry value or plist that points at a path that no longer exists. The daemon
 * would then simply stop starting at login, with nothing to show why.
 * No-op when start-at-login is not enabled.
 */
export function refreshStartupEntry(configDir: string, deps: StartupDeps = {}): StartupResult | null {
  if (!isStartupEnabled(configDir, deps)) {
    return null;
  }
  return enableStartup(configDir, deps);
}

/** One daemon-log line per failure and per warning of a refresh; null (nothing to refresh) writes nothing. */
export function reportStartupRefresh(result: StartupResult | null, write: (line: string) => void): void {
  if (result && !result.ok) {
    write(`start-at-login refresh failed: ${result.error}`);
  }
  for (const w of result?.warnings ?? []) {
    write(`start-at-login warning: ${w}`);
  }
}

/**
 * Whether it's safe to delete staged binaries from stamps other than the current one.
 *
 * Not safe when the registry/plist refresh failed: it still names the OLD stamp (the write
 * never happened), and deleting that stamp would break login with no way to self-repair.
 */
export function shouldPruneStaleBinaries(startupRefresh: StartupResult | null): boolean {
  return startupRefresh === null || startupRefresh.ok;
}
