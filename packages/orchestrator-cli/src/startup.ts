import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';

const REG_KEY            = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LAUNCH_AGENT_LABEL = 'com.wadeck.orchestrator';

// Mirrors `nodeScript` in ci/launcher.config.json, which is baked into the Go launcher.
// At login the launcher is started bare: neither the registry value nor the launchd plist
// can inject LAUNCHER_BUNDLE_OVERRIDE the way bin/orch.js does, so the launcher can only
// find the daemon bundle relative to its own directory. The platform package holding the
// launcher sits next to the main package under node_modules/@wadeck-app/.
const LAUNCHER_NODE_SCRIPT = path.join('..', 'orchestrator-cli', 'dist', 'orchestrator.cjs');

const _PLATFORM_PKG: Record<string, string> = {
  'win32-x64':    '@wadeck-app/orchestrator-cli-win32-x64',
  'darwin-arm64': '@wadeck-app/orchestrator-cli-darwin-arm64',
  'darwin-x64':   '@wadeck-app/orchestrator-cli-darwin-x64',
};
const _platformArch = process.arch === 'arm64' ? 'arm64' : 'x64';
const _platformKey  = `${process.platform}-${_platformArch}`;
const _platformPkg  = _PLATFORM_PKG[_platformKey];
const LAUNCHER_BINARY = process.platform === 'win32' ? 'orchestrator.exe' : 'orchestrator';

function findLauncherBinary(): string | null {
  // Try the platform package first (production install via optionalDependencies).
  if (_platformPkg) {
    try {
      return require.resolve(`${_platformPkg}/${LAUNCHER_BINARY}`);
    } catch {
      // Platform package not installed - fall through to local paths (dev/CI builds).
    }
  }
  // Fallback: local paths used during development or legacy installs.
  const candidates = [
    path.join(__dirname, LAUNCHER_BINARY),
    path.join(__dirname, '..', 'launcher-go', 'dist', LAUNCHER_BINARY),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function buildRegValueName(configDir: string): string {
  return `Orchestrator (${configDir})`;
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/** Daemon entry next to this module: the published bundle, or the tsc output in dev. */
function findDaemonEntry(): string | null {
  const candidates = [
    path.join(__dirname, 'orchestrator.cjs'),
    path.join(__dirname, 'index.js'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Absolute path the Go launcher will resolve for its bundle when started bare at login. */
function launcherBundlePath(launcher: string): string {
  return path.resolve(path.dirname(launcher), LAUNCHER_NODE_SCRIPT);
}

/**
 * Verifies the entry we are about to register will actually resolve at login.
 * Returns an actionable error message, or null when the target is sound.
 * Without this a broken entry is written silently and only fails at the next login.
 */
function validateStartupTarget(): string | null {
  const launcher = findLauncherBinary();
  if (launcher) {
    const bundle = launcherBundlePath(launcher);
    if (!fs.existsSync(bundle)) {
      return `start-at-login would fail: launcher ${launcher} resolves its daemon bundle to `
        + `${bundle}, which does not exist. Re-install with: npm install -g @wadeck-app/orchestrator-cli`;
    }
    return null;
  }
  if (!findDaemonEntry()) {
    return `start-at-login cannot be registered: no launcher binary, and no daemon bundle next to `
      + `${__dirname}. Re-install with: npm install -g @wadeck-app/orchestrator-cli`;
  }
  return null;
}

export function buildWindowsCommand(configDir: string): string {
  const launcher = findLauncherBinary();
  if (launcher) return `${cmdQuote(launcher)} ${cmdQuote(configDir)}`;
  const entry = findDaemonEntry();
  if (!entry) throw new Error('buildWindowsCommand: no launcher binary and no daemon bundle found');
  return [process.execPath, entry, configDir].map(cmdQuote).join(' ');
}

export function buildMacArgs(configDir: string): string[] {
  const launcher = findLauncherBinary();
  if (launcher) return [launcher, configDir];
  const entry = findDaemonEntry();
  if (!entry) throw new Error('buildMacArgs: no launcher binary and no daemon bundle found');
  return [process.execPath, entry, configDir];
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
    <string>${xmlEscape(configDir)}</string>
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
  if (/[\r\n\x00]/.test(configDir)) return { ok: false, error: 'configDir contains invalid characters' };

  const unusable = validateStartupTarget();
  if (unusable) return { ok: false, error: unusable };

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
  if (/[\r\n\x00]/.test(configDir)) return { ok: false, error: 'configDir contains invalid characters' };
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
  if (process.platform === 'darwin') return fs.existsSync(macPlistPath());
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
  if (!isStartupEnabled(configDir)) return null;
  return enableStartup(configDir);
}
