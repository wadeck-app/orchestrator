import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';
import { findLauncherBinary, findDaemonEntry, launcherToRun } from './platform-binary.js';

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

function macPlistPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCH_AGENT_LABEL}.plist`);
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildMacPlist(programArguments: string[], configDir: string): string {
  const argsXml    = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
  const logDir     = xmlEscape(path.join(configDir, 'logs'));
  const nodeBinDir = xmlEscape(path.dirname(process.execPath));
  const envPath    = [nodeBinDir, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
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

export function enableStartup(configDir: string): StartupResult {
  if (/[\r\n\x00]/.test(configDir)) {
    return { ok: false, error: 'configDir contains invalid characters' };
  }

  // Platform first: on a target with no start-at-login mechanism at all, reporting a missing
  // launcher would name a consequence instead of the actual reason.
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ok: false, error: `Unsupported platform: ${process.platform}` };
  }

  const unusable = validateStartupTarget();
  if (unusable) {
    return { ok: false, error: unusable };
  }

  if (process.platform === 'darwin') {
    const plistPath = macPlistPath();
    const uid       = process.getuid?.() ?? 0;
    const target    = `gui/${uid}/${LAUNCH_AGENT_LABEL}`;
    const diag: string[] = [];

    try {
      fs.mkdirSync(path.dirname(plistPath), { recursive: true });
      const args  = buildMacArgs(configDir);
      const plist = buildMacPlist(args, configDir);
      const tmp   = plistPath + '.tmp';
      fs.writeFileSync(tmp, plist, 'utf8');
      fs.renameSync(tmp, plistPath);
      diag.push('plist=written');
    } catch (e) { return { ok: false, error: `Failed to write plist: ${(e as Error).message}` }; }

    try { execFileSync('launchctl', ['enable', target], { stdio: 'pipe', windowsHide: true }); diag.push('enable=ok'); }
    catch (e) { diag.push(`enable=failed(${(e as Error).message?.trim()})`); }

    return { ok: true, detail: diag.join(' | ') };
  }

  if (process.platform === 'win32') {
    const valueName = buildRegValueName(configDir);
    const value     = buildWindowsCommand(configDir);
    try {
      execFileSync('reg', ['add', REG_KEY, '/v', valueName, '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'pipe', windowsHide: true });
    } catch (e) { return { ok: false, error: `reg.exe failed: ${(e as Error).message}` }; }
    return { ok: true, detail: `registry key set: ${REG_KEY}\\${valueName}` };
  }

  return { ok: false, error: `Unsupported platform: ${process.platform}` };
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

export function isStartupEnabled(configDir: string): boolean {
  if (process.platform === 'darwin') {
    // The launchd label is a single global one, so the plist must also be checked to belong to
    // THIS configDir. Otherwise a second instance sees "enabled" and refreshStartupEntry, which
    // now runs on every daemon start, silently rewrites the plist to its own configDir and
    // steals the login entry from the first.
    try {
      return fs.readFileSync(macPlistPath(), 'utf8').includes(`<string>${xmlEscape(configDir)}</string>`);
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
export function refreshStartupEntry(configDir: string): StartupResult | null {
  if (!isStartupEnabled(configDir)) {
    return null;
  }
  return enableStartup(configDir);
}
