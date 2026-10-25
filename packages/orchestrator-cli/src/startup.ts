import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';
import { findLauncherBinary, findDaemonEntry, launcherToRun } from './platform-binary.js';
import {
  planMacPath, mergeMacPath, realShellRunner, realIsExecutableFile,
  type MacPathDeps,
} from './login-shell-path.js';

const REG_KEY            = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LAUNCH_AGENT_LABEL = 'com.wadeck.orchestrator';

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

export function enableStartup(configDir: string, deps: StartupDeps = {}): StartupResult {
  const platform = deps.platform ?? process.platform;
  const exec     = deps.exec ?? execFileSync;
  if (/[\r\n\x00]/.test(configDir)) {
    return { ok: false, error: 'configDir contains invalid characters' };
  }

  // Platform first: on a target with no start-at-login mechanism at all, reporting a missing
  // launcher would name a consequence instead of the actual reason.
  if (platform !== 'darwin' && platform !== 'win32') {
    return { ok: false, error: `Unsupported platform: ${platform}` };
  }

  const unusable = (deps.validateTarget ?? validateStartupTarget)();
  if (unusable) {
    return { ok: false, error: unusable };
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

export function disableStartup(configDir: string): StartupResult {
  if (/[\r\n\x00]/.test(configDir)) {
    return { ok: false, error: 'configDir contains invalid characters' };
  }
  if (process.platform === 'darwin') {
    const plistPath = macPlistPath();
    const uid       = process.getuid?.() ?? 0;
    const target    = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
    const diag: string[] = [];

    try { execFileSync('launchctl', ['bootout', target],  { stdio: 'pipe', windowsHide: true }); diag.push('bootout=ok'); }
    catch (e) { diag.push(`bootout=skipped(${(e as Error).message?.trim()})`); }

    try { execFileSync('launchctl', ['disable', target], { stdio: 'pipe', windowsHide: true }); diag.push('disable=ok'); }
    catch (e) { diag.push(`disable=failed(${(e as Error).message?.trim()})`); }

    try { fs.unlinkSync(plistPath); diag.push('plist=removed'); }
    catch { diag.push('plist=already-absent'); }

    return { ok: true, detail: diag.join(' | ') };
  }

  if (process.platform === 'win32') {
    const valueName = buildRegValueName(configDir);
    try { execFileSync('reg', ['delete', REG_KEY, '/v', valueName, '/f'], { stdio: 'pipe', windowsHide: true }); }
    catch { /* already absent */ }
    return { ok: true, detail: `registry key removed: ${REG_KEY}\\${valueName}` };
  }

  return { ok: false, error: `Unsupported platform: ${process.platform}` };
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
  if (process.platform === 'win32') {
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
