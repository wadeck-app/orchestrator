import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs   from 'node:fs';
import os   from 'node:os';
import type { StartupResult } from './types.js';

const REG_KEY            = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LAUNCH_AGENT_LABEL = 'com.wadeck.orchestrator';
const INDEX_JS           = path.join(__dirname, 'index.js');

function findLauncherBinary(): string | null {
  if (process.platform === 'win32') {
    return [
      path.join(__dirname, 'orchestrator.exe'),
      path.join(__dirname, '..', 'launcher-go', 'dist', 'orchestrator.exe'),
    ].find((p) => fs.existsSync(p)) ?? null;
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    return [
      path.join(__dirname, 'orchestrator'),
      path.join(__dirname, '..', 'launcher-go', 'dist', `orchestrator_darwin_${arch}`),
    ].find((p) => fs.existsSync(p)) ?? null;
  }
  return null;
}

export function buildRegValueName(configDir: string): string {
  return `Orchestrator (${configDir})`;
}

function cmdQuote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

export function buildWindowsCommand(configDir: string): string {
  const launcher = findLauncherBinary();
  if (launcher) return `${cmdQuote(launcher)} ${cmdQuote(configDir)}`;
  return [process.execPath, INDEX_JS, configDir].map(cmdQuote).join(' ');
}

export function buildMacArgs(configDir: string): string[] {
  const launcher = findLauncherBinary();
  return launcher ? [launcher, configDir] : [process.execPath, INDEX_JS, configDir];
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
    try {
      const out = execFileSync('reg', ['query', REG_KEY, '/v', buildRegValueName(configDir)],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      return out.includes(process.execPath);
    } catch { return false; }
  }
  return false;
}
