import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRegistration, describeRegistrationFailure, registerModule } from '@wadeck-app/app-core-sdk/register';
import { getErrorMessage } from './fsUtil.js';

/*
 * Talking to app-core (the port, the POST, the pickup file when it is not running, the wording of each
 * outcome) is app-core-sdk's job, shared with every other module. What stays here is what only this
 * package knows: where its module is, copying it out of the npm folder, and when to register.
 */

/** app-core's config dir, which APP_CORE_CONFIG_DIR overrides the way app-core itself honours it. */
export function getAppCoreConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  // violations-suppress: shared/no-out-of-repo-path ~/.config/app-core IS app-core's config dir, and APP_CORE_CONFIG_DIR is the override it offers
  return env['APP_CORE_CONFIG_DIR'] ?? path.join(os.homedir(), '.config', 'app-core');
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
    log(describeRegistration({ status: 'skipped', reason: `app-core is not installed (${appCoreConfigDir} does not exist)` }, APP_CORE_MODULE_ID));
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

    // The SDK reads the config dir from the environment, as app-core itself does.
    const outcome = await registerModule({ id: APP_CORE_MODULE_ID, manifestPath, env: { ...env, APP_CORE_CONFIG_DIR: appCoreConfigDir } });
    log(describeRegistration(outcome, APP_CORE_MODULE_ID));

    // Older copies go only once app-core holds the new path (accepted now, or left as the file it reads
    // at its next start). A refusal means it still remembers the old one, which must keep working.
    if (copy !== undefined && (outcome.status === 'registered' || outcome.status === 'deferred')) {
      pruneStagedModules(copy.orchConfigDir, copy.stamp);
    }
  } catch (err) {
    log(describeRegistrationFailure(err));
  }
}
