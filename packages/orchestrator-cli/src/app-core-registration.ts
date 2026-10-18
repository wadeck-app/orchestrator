import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getErrorMessage } from './fsUtil.js';

/** app-core's default port, used when neither APP_CORE_PORT nor its own port file says otherwise. */
const DEFAULT_APP_CORE_PORT = 4850;
const DEFAULT_TIMEOUT_MS = 3000;

export type RegistrationOutcome =
  /** app-core took the module. */
  | { status: 'registered'; port: number }
  /** app-core is running and said no: its own reason is kept, it names what to fix. */
  | { status: 'refused'; port: number; httpStatus: number; reason: string }
  /** app-core is installed but not running; the pickup file it reads at its next start was written. */
  | { status: 'deferred'; file: string }
  /** app-core is not installed here; nothing was written. */
  | { status: 'skipped'; reason: string };

export interface RegistrationOptions {
  /** The module id: the prefix of its components and routes in app-core. */
  id: string;
  manifestPath: string;
  /** app-core's config dir: where it keeps its port file and the modules it loads at start. */
  appCoreConfigDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

/** app-core's config dir, which APP_CORE_CONFIG_DIR overrides the way app-core itself honours it. */
export function getAppCoreConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  // violations-suppress: shared/no-out-of-repo-path ~/.config/app-core IS app-core's config dir, and APP_CORE_CONFIG_DIR is the override it offers
  return env['APP_CORE_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'app-core');
}

/**
 * The port app-core listens on: APP_CORE_PORT, else the one it wrote for itself (the port it really
 * bound, which differs from the default when that one was taken), else its default.
 *
 * A malformed APP_CORE_PORT throws instead of falling through to another source: the variable was set
 * on purpose, and quietly talking to a different port is how a test run ends up registering with the
 * user's real app-core.
 */
export function resolveAppCorePort(appCoreConfigDir: string, env: NodeJS.ProcessEnv = process.env): number {
  const fromEnv = env['APP_CORE_PORT'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const port = Number(fromEnv);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`APP_CORE_PORT must be a port number, found "${fromEnv}".`);
    }
    return port;
  }
  try {
    const written = JSON.parse(fs.readFileSync(path.join(appCoreConfigDir, 'server.port.json'), 'utf8')) as { port?: unknown };
    if (typeof written.port === 'number' && Number.isInteger(written.port) && written.port > 0) {
      return written.port;
    }
  } catch {
    // No port file, or one that is not JSON: app-core was never started here or wrote it badly. The default is the next best guess.
  }
  return DEFAULT_APP_CORE_PORT;
}

async function refusalReason(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim() !== '') {
      return parsed.error;
    }
  } catch {
    // Not JSON: report what was actually said.
  }
  return text.trim() === '' ? response.statusText || 'no reason given' : text.trim();
}

/**
 * Tells app-core where this daemon's module lives (POST /api/modules/register, which also reloads a
 * module it already knows). Best effort and never throws for "app-core is not there": that is the
 * normal state of a machine without app-core, and the daemon must start the same either way.
 *
 * It does throw for a manifest that does not exist. That one is ours to fix, a package that was built
 * without its module, and reporting it as "app-core unreachable" would send the reader looking in the
 * wrong place.
 */
export async function registerWithAppCore(options: RegistrationOptions): Promise<RegistrationOutcome> {
  const { id, manifestPath, appCoreConfigDir, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`app-core module manifest not found at ${manifestPath}: this package was built without its app-module. Rebuild it, or set appCore: false in config.yml to stop registering.`);
  }

  const payload = { id, source: { type: 'file', path: manifestPath } };
  const port = resolveAppCorePort(appCoreConfigDir, env);

  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/api/modules/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    // Connection refused, or an app-core that accepted and never answered: either way it is not serving.
    return leavePickupFile(id, payload, appCoreConfigDir);
  }

  if (response.ok) {
    return { status: 'registered', port };
  }
  return { status: 'refused', port, httpStatus: response.status, reason: await refusalReason(response) };
}

/**
 * app-core reads <configDir>/modules/<id>.json at its own start, so a registration it missed is
 * still honoured. Only written when app-core has been set up here at all: creating its folder for a
 * user who never installed it would be clutter from a product they do not use.
 */
function leavePickupFile(id: string, payload: object, appCoreConfigDir: string): RegistrationOutcome {
  if (!fs.existsSync(appCoreConfigDir)) {
    return { status: 'skipped', reason: `app-core is not installed (${appCoreConfigDir} does not exist)` };
  }
  const file = path.join(appCoreConfigDir, 'modules', `${id}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload));
  return { status: 'deferred', file };
}

/** One daemon-log line per outcome. A refusal says what to do, since nobody is watching when it happens. */
export function describeOutcome(outcome: RegistrationOutcome, id: string): string {
  switch (outcome.status) {
    case 'registered':
      return `app-core: module "${id}" registered (app-core on port ${outcome.port})`;
    case 'deferred':
      return `app-core: not running, left ${outcome.file} for its next start`;
    case 'skipped':
      return `app-core: module "${id}" not registered, ${outcome.reason}`;
    case 'refused':
      return `app-core: refused module "${id}" (HTTP ${outcome.httpStatus}): ${outcome.reason}. Fix the manifest it names, or set appCore: false in config.yml to stop registering. app-core was on port ${outcome.port}.`;
  }
}

/** For the daemon's catch: an error while registering must never be mistaken for a crash. */
export function describeRegistrationFailure(err: unknown): string {
  return `app-core: registration failed, the daemon runs on without it: ${getErrorMessage(err)}`;
}

/**
 * The module's manifest: inside the installed package (`app-module/`, assembled when the package is
 * built), else the sibling package of a source checkout. The installed one wins, so a checkout next
 * to an install cannot shadow what that install actually ships.
 */
export function findAppModuleManifest(packageRoot: string): string | undefined {
  return appModuleManifestCandidates(packageRoot).find(candidate => fs.existsSync(candidate));
}

function appModuleManifestCandidates(packageRoot: string): string[] {
  return [
    path.join(packageRoot, 'app-module', 'manifest.json'),
    path.join(packageRoot, '..', 'app-module-orchestrator', 'manifest.json'),
  ];
}

/** Where the module is, and whether it is the copy npm installed (which must not be what app-core remembers). */
interface FoundModule {
  manifestPath: string;
  /** The folder holding the manifest. */
  dir: string;
  /** Shipped inside the installed package, as opposed to the sibling package of a source checkout. */
  installed: boolean;
}

function findAppModule(packageRoot: string): FoundModule | undefined {
  const installed = path.join(packageRoot, 'app-module', 'manifest.json');
  if (fs.existsSync(installed)) {
    return { manifestPath: installed, dir: path.dirname(installed), installed: true };
  }
  const sibling = path.join(packageRoot, '..', 'app-module-orchestrator', 'manifest.json');
  if (fs.existsSync(sibling)) {
    return { manifestPath: sibling, dir: path.dirname(sibling), installed: false };
  }
  return undefined;
}

/** A stamp is a folder name chosen by us (a package version), never a path. */
const STAMP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function stagedModulesRoot(orchConfigDir: string): string {
  return path.join(orchConfigDir, 'app-module');
}

/**
 * Copies the module out of the npm folder into `<orchConfigDir>/app-module/<stamp>/` and returns the
 * manifest to register.
 *
 * app-core stores the PATH of a manifest and reloads from it at its own every start. npm replaces the
 * package folder on every update and deletes it on uninstall, so a path into node_modules is a path
 * that dies, and app-core would be left reporting a module that cannot load. The copy lives in the
 * config dir, which belongs to the user and not to npm: the module keeps working across updates and
 * after an uninstall, until it is removed from app-core on purpose. Same reason, same shape as the
 * native launcher binary (platform-binary.ts).
 *
 * Once per stamp: a complete copy is kept. Written beside the target and renamed, so a crash cannot
 * leave a half-copied folder at the path app-core would load from.
 */
export function stageAppModule(sourceDir: string, orchConfigDir: string, stamp: string): string {
  if (!STAMP_RE.test(stamp)) {
    throw new Error(`Cannot stage the app-core module: "${stamp}" is not a usable version stamp (letters, digits, ".", "_" and "-" only).`);
  }
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json'))) {
    throw new Error(`Cannot stage the app-core module: no manifest.json in ${sourceDir}.`);
  }
  const target = path.join(stagedModulesRoot(orchConfigDir), stamp);
  const manifest = path.join(target, 'manifest.json');
  if (fs.existsSync(manifest)) {
    return manifest;
  }
  try {
    const partial = `${target}.partial`;
    fs.rmSync(partial, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(sourceDir, partial, { recursive: true });
    fs.renameSync(partial, target);
  } catch (err) {
    throw new Error(`Cannot stage the app-core module into ${target} (${getErrorMessage(err)}). It is copied out of the npm folder on purpose, so that updating or removing the package cannot break what app-core remembers.`);
  }
  return manifest;
}

/**
 * Removes the staged copies of every version but `keepStamp`, and returns how many went. A failure to
 * remove one is skipped: the next start tries again, and a leftover copy costs disk, not correctness.
 */
export function pruneStagedModules(orchConfigDir: string, keepStamp: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagedModulesRoot(orchConfigDir), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name === keepStamp) {
      continue;
    }
    try {
      fs.rmSync(path.join(stagedModulesRoot(orchConfigDir), entry.name), { recursive: true, force: true });
      removed++;
    } catch {
      // Still in use or locked: left for the next start.
    }
  }
  return removed;
}

export interface RegisterOnStartOptions {
  /** `appCore` in config.yml. */
  enabled: boolean;
  /** ORCH_DEV_INSTANCE: a checkout run for development. */
  devInstance: boolean;
  /** The installed package's root (the folder holding package.json). */
  packageRoot: string;
  /** This daemon's own config dir: where the module is copied to. Needed for an installed package. */
  orchConfigDir?: string;
  /** What names this version's copy, normally the package version. Needed for an installed package. */
  moduleStamp?: string;
  appCoreConfigDir?: string;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/** The module id app-core knows the dashboard by: the prefix of its components and routes. */
export const APP_CORE_MODULE_ID = 'orchestrator';

/**
 * What the daemon does about app-core when it starts, deciding and logging in one place. Never
 * rejects: whatever goes wrong here is a line in the daemon log, not a daemon that fails to start.
 */
export async function registerOnStart(options: RegisterOnStartOptions): Promise<void> {
  const { enabled, devInstance, packageRoot, log, env = process.env } = options;
  const appCoreConfigDir = options.appCoreConfigDir ?? getAppCoreConfigDir(env);

  if (!enabled) {
    log('app-core: registration turned off (appCore: false in config.yml)');
    return;
  }
  if (devInstance) {
    log('app-core: not registering a development instance (ORCH_DEV_INSTANCE=1), so a checkout cannot replace the installed module');
    return;
  }

  const found = findAppModule(packageRoot);
  if (found === undefined) {
    log(`app-core: no app-module found, not registering. Looked for ${appModuleManifestCandidates(packageRoot).join(' and ')}. A published install should ship one: reinstall with "orch cli update", or set appCore: false in config.yml.`);
    return;
  }
  // Before anything is copied: a machine that never installed app-core gets no folder, no network call.
  if (!fs.existsSync(appCoreConfigDir)) {
    log(describeOutcome({ status: 'skipped', reason: `app-core is not installed (${appCoreConfigDir} does not exist)` }, APP_CORE_MODULE_ID));
    return;
  }

  try {
    let manifestPath = found.manifestPath;
    let copy: { orchConfigDir: string; stamp: string } | undefined;
    if (found.installed) {
      const { orchConfigDir, moduleStamp } = options;
      if (orchConfigDir === undefined || moduleStamp === undefined) {
        throw new Error('an installed app-module is copied before it is registered, and this call gave no orchConfigDir or moduleStamp to copy it with');
      }
      manifestPath = stageAppModule(found.dir, orchConfigDir, moduleStamp);
      copy = { orchConfigDir, stamp: moduleStamp };
    }

    const outcome = await registerWithAppCore({ id: APP_CORE_MODULE_ID, manifestPath, appCoreConfigDir, env });
    log(describeOutcome(outcome, APP_CORE_MODULE_ID));

    // Older copies go only once app-core holds the new path (accepted now, or left as the file it reads
    // at its next start). A refusal means it still remembers the old one, which must keep working.
    if (copy !== undefined && (outcome.status === 'registered' || outcome.status === 'deferred')) {
      pruneStagedModules(copy.orchConfigDir, copy.stamp);
    }
  } catch (err) {
    log(describeRegistrationFailure(err));
  }
}
