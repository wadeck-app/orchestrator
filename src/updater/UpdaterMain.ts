// UpdaterMain.ts -- background auto-update entry point for @wadeck-app/orchestrator-cli.
// Bundled by CI as dist/orchestrator-updater.cjs (esbuild, platform=node, format=cjs).
// Spawned as a detached process by UpdateManager.scheduleBackgroundUpdate().
// Must NOT import any orchestrator runtime modules -- only node: builtins are safe here.
import { execFile } from 'node:child_process';
import * as fs   from 'node:fs';
import * as http from 'node:http';
import * as os   from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
// On Windows, npm is a .cmd script -- execFile without shell:true cannot find it.
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPM_SHELL = process.platform === 'win32' ? { shell: true as const } : {};

// Injected by esbuild at bundle time; falls back to 'dev' when running from source.
declare const __ORCH_VERSION__: string;

const PKG_NAME = process.env['UPDATER_PKG_NAME'] ?? '@wadeck-app/orchestrator-cli';

// Registry URL -- same as publishConfig in package.json.
const REGISTRY = 'https://npm.pkg.github.com/';

// Minimal semver comparison: returns true when a <= b (ignores pre-release suffix).
export function semverLte(a: string, b: string): boolean {
  const parse = (v: string): [number, number, number] => {
    const core = v.split(/[-+]/)[0] ?? v;
    const [maj = '0', min = '0', pat = '0'] = core.split('.');
    return [parseInt(maj, 10), parseInt(min, 10), parseInt(pat, 10)];
  };
  const [aMaj, aMin, aPat] = parse(a);
  const [bMaj, bMin, bPat] = parse(b);
  if (aMaj !== bMaj) return aMaj < bMaj;
  if (aMin !== bMin) return aMin < bMin;
  return aPat <= bPat;
}

interface UpdateState {
  status: 'success' | 'rolled-back' | 'update-failed' | 'applying';
  newVersion?:      string;
  previousVersion?: string;
  targetVersion?:   string;
  reason?:          string;
  timestamp:        string;
}

interface UpdateCache {
  checkedAt: number;
}

function orchConfigDir(): string {
  if (process.env['ORCH_CONFIG_DIR']) return process.env['ORCH_CONFIG_DIR'];
  const xdg = process.env['XDG_CONFIG_HOME'];
  return xdg ? path.join(xdg, 'orchestrator') : path.join(os.homedir(), '.config', 'orchestrator');
}

function statePath(configDir: string):  string { return path.join(configDir, 'update-state.json'); }
function lockPath(configDir: string):   string { return path.join(configDir, '.update.lock'); }
function cachePath(configDir: string):  string { return path.join(configDir, '.update-cache.json'); }
function logPath(configDir: string):    string { return path.join(configDir, 'update-log.txt'); }

function appendLog(configDir: string, msg: string): void {
  try {
    fs.appendFileSync(logPath(configDir), `[${new Date().toISOString()}] ${msg}\n`);
  } catch { /* ignore */ }
}

function writeState(configDir: string, state: UpdateState): void {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(statePath(configDir), JSON.stringify(state, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

// Lock file: write PID, return true if acquired (stale PID = dead process, take it).
export function tryAcquireLock(lockFile: string): boolean {
  try {
    const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    try {
      const existing = parseInt(fs.readFileSync(lockFile, 'utf-8').trim(), 10);
      if (!isNaN(existing)) {
        try { process.kill(existing, 0); return false; } catch { /* stale */ }
      }
      fs.unlinkSync(lockFile);
      const fd = fs.openSync(lockFile, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch { return false; }
  }
}

// Check interval: configurable via ORCH_UPDATE_INTERVAL env var (e.g. '4h', '30m').
// Default: 4 hours.
function getCheckIntervalMs(): number {
  const raw = process.env['ORCH_UPDATE_INTERVAL'] ?? '4h';
  const m = /^(\d+)([mhd])$/.exec(raw.trim());
  if (!m) return 4 * 60 * 60 * 1000;
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case 'm': return n * 60_000;
    case 'h': return n * 3_600_000;
    case 'd': return n * 86_400_000;
    default:  return 4 * 3_600_000;
  }
}

export async function main(): Promise<void> {
  const configDir = orchConfigDir();
  fs.mkdirSync(configDir, { recursive: true });

  const lock = lockPath(configDir);
  let acquired = false;

  try {
    acquired = tryAcquireLock(lock);
    if (!acquired) return; // another updater running

    // Respect check interval cache (skip unless UPDATER_FORCE=1)
    const force = process.env['UPDATER_FORCE'] === '1';
    const cache = cachePath(configDir);
    if (!force && fs.existsSync(cache)) {
      try {
        const c = JSON.parse(fs.readFileSync(cache, 'utf-8')) as UpdateCache;
        if (Date.now() - c.checkedAt < getCheckIntervalMs()) return;
      } catch { /* proceed */ }
    }
    try { fs.writeFileSync(cache, JSON.stringify({ checkedAt: Date.now() })); } catch { /* ignore */ }

    const timestamp = new Date().toISOString();

    // Check latest version on registry
    let latest: string;
    try {
      const { stdout } = await execFileAsync(
        NPM_CMD,['view', PKG_NAME, 'dist-tags.latest', '--registry', REGISTRY],
        { timeout: 15_000, ...NPM_SHELL },
      );
      latest = stdout.trim();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const reason = msg.includes('401') || msg.includes('UNAUTHORIZED') ? 'auth' : 'network';
      writeState(configDir, { status: 'update-failed', reason, timestamp });
      appendLog(configDir, `Version check failed: ${msg}`);
      return;
    }

    if (!/^\d+[.\d]+/.test(latest)) {
      writeState(configDir, { status: 'update-failed', reason: 'invalid-version', timestamp });
      return;
    }

    // Determine current version (injected by esbuild; undefined in dev mode)
    let current: string;
    try { current = __ORCH_VERSION__; }
    catch { return; } // dev mode -- skip

    if (semverLte(latest, current)) {
        if (force) process.stdout.write(`[orch] Already up to date (v${current})\n`);
        return;
    }

    // Step 1: Write config.update sentinel — Go launcher (T8) will run updateCmd after node exits
    const sentinelPath = path.join(configDir, 'config.update');
    fs.writeFileSync(sentinelPath, '1', 'utf-8');

    // Step 2: Read config.port to find the daemon's HTTP health port
    const portFile = path.join(configDir, 'config.port');
    let port: number | null = null;
    try {
      const portData = JSON.parse(fs.readFileSync(portFile, 'utf-8')) as { port: number };
      port = portData.port;
    } catch { /* daemon may not be running */ }

    // Step 3: Send quit command to daemon so it shuts down cleanly (kills tray before exit)
    if (port !== null) {
      try {
        const healthToken = fs.readFileSync(path.join(configDir, 'health_token'), 'utf-8').trim();
        await new Promise<void>((resolve) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/quit',
            method: 'POST',
            timeout: 5000,
            headers: {
              Authorization: `Bearer ${healthToken}`,
              'Content-Type': 'application/json',
              'Content-Length': 0,
            },
          }, () => resolve());
          req.on('error', () => resolve()); // daemon may already be down
          req.on('timeout', () => { req.destroy(); resolve(); });
          req.end();
        });
      } catch { /* ignore */ }
    }

    // Step 4: Write update state so the new version can display "updated to X.Y.Z" after restart
    writeState(configDir, { status: 'success', newVersion: latest, previousVersion: current, timestamp });
    appendLog(configDir, `Sentinel written — launcher will install ${current} → ${latest}`);

  } catch (e) {
    appendLog(configDir, `Unexpected updater error: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    if (acquired) { try { fs.unlinkSync(lock); } catch { /* ignore */ } }
  }
}

const isEntry =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('UpdaterMain.js') ||
   process.argv[1].endsWith('UpdaterMain.ts') ||
   process.argv[1].endsWith('orchestrator-updater.cjs'));

if (isEntry) {
  main().catch(() => process.exit(1));
}
