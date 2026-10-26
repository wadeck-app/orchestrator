import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';
import { getErrorMessage } from './fsUtil.js';
import { findLauncherBinary, findDaemonEntry, launcherToRun } from './platform-binary.js';
import {
  planMacPath, mergeMacPath, realShellRunner, realIsExecutableFile,
  type MacPathDeps,
} from './login-shell-path.js';

const REG_KEY            = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
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
function validateStartupTarget(): string | null {
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
export function buildMacPlist(programArguments: string[], configDir: string, pathEntries?: readonly string[]): string {
  const argsXml    = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const logDir     = xmlEscape(path.join(configDir, 'logs'));
  const envPath    = xmlEscape((pathEntries ?? mergeMacPath(path.dirname(process.execPath), [])).join(':'));
  // launchd can inject environment variables, so on macOS the launcher is handed an absolute
  // bundle path and never has to resolve it relative to its own directory. That is what makes
  // start-at-login here independent of whether npm hoisted or nested the platform package.
  const bundle = findDaemonEntry();
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
      + 'container, a daemon can only start without a login session if an administrator runs `loginctl enable-linger $USER` '
      + '(orch does not run it: it needs privileges); then run `orch install` again.';
  }
  return `\`systemctl --user ${verb}\` failed: ${raw}. ${state}`;
}

function enableSystemd(configDir: string, deps: StartupDeps, exec: typeof execFileSync): StartupResult {
  const unitPath = deps.unitPath ?? defaultUnitPath();
  const diag: string[] = [];
  let warnings: string[] = [];

  try {
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    const args = deps.programArguments ?? buildMacArgs(configDir);
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
    warnings = plan.warnings;
    diag.push(plan.captured ? 'path=login-shell' : 'path=default');
    const bundle = deps.daemonEntry !== undefined ? deps.daemonEntry : findDaemonEntry();
    const unit   = buildSystemdUnit(args, configDir, plan.entries, bundle);
    const tmp    = unitPath + '.tmp';
    fs.writeFileSync(tmp, unit, 'utf8');
    fs.renameSync(tmp, unitPath);
    diag.push('unit=written');
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
  diag.push('it starts at your login; to start at boot with no login run `loginctl enable-linger $USER` (needs privileges, not run by orch)');
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

  const unusable = (deps.validateTarget ?? validateStartupTarget)();
  if (unusable) {
    return { ok: false, error: unusable };
  }

  if (platform === 'linux') {
    return enableSystemd(configDir, deps, exec);
  }

  if (platform === 'darwin') {
    const plistPath = deps.plistPath ?? macPlistPath();
    const uid       = process.getuid?.() ?? 0;
    const target    = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
    const diag: string[] = [];
    let warnings: string[] = [];

    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      const args  = deps.programArguments ?? buildMacArgs(configDir);
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
      warnings = plan.warnings;
      diag.push(plan.captured ? 'path=login-shell' : 'path=default');
      const plist = buildMacPlist(args, configDir, plan.entries);
      const tmp   = plistPath + '.tmp';
      fs.writeFileSync(tmp, plist, 'utf8');
      fs.renameSync(tmp, plistPath);
      diag.push('plist=written');
    } catch (e) { return { ok: false, error: `Failed to write plist: ${(e as Error).message}` }; }

    try { exec('launchctl', ['enable', target], { stdio: 'pipe', windowsHide: true }); diag.push('enable=ok'); }
    catch (e) { diag.push(`enable=failed(${(e as Error).message?.trim()})`); }

    return warnings.length > 0
      ? { ok: true, detail: diag.join(' | '), warnings }
      : { ok: true, detail: diag.join(' | ') };
  }

  if (platform === 'win32') {
    const valueName = buildRegValueName(configDir);
    const value     = deps.windowsCommand ?? buildWindowsCommand(configDir);
    try {
      exec('reg', ['add', REG_KEY, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe', windowsHide: true });
    } catch (e) { return { ok: false, error: `reg.exe failed: ${(e as Error).message}` }; }
    return { ok: true, detail: `registry key set: ${REG_KEY}\\${valueName}` };
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

export function disableStartup(configDir: string, deps: StartupDeps = {}): StartupResult {
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
      const out = execFileSync('reg', ['query', REG_KEY, '/v', valueName],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return out.includes(valueName);
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
