import fs from 'node:fs';
import path from 'node:path';
import { launcherBundleOverride } from './launcher-bundle.js';

/**
 * What a launcher started from `<configDir>/bin/<stamp>/` needs to find the daemon bundle.
 *
 * The Go launcher looks for the bundle next to itself, under `<dirname of node>/node_modules`, and by walking up `node_modules`
 * from its own folder. A staged copy has no `node_modules` above it, so only the second one is left, and it fails when the global
 * modules are somewhere else (`%APPDATA%\npm`, the default of the Windows installer). The other platforms hand the launcher
 * LAUNCHER_BUNDLE_OVERRIDE in the login entry; a Windows Run value cannot carry it.
 *
 * Null when the launcher finds the bundle by itself, or when the bundle is not under `<modules>/<spec>` (a checkout, which has no
 * staged launcher either).
 */
export function planBundleLink(opts: {
  daemonPath: string;
  spec: string;
  nodeDir: string | null;
  realpath?: (p: string) => string;
}): { modulesDir: string } | null {
  if (launcherBundleOverride(opts) === undefined) {
    return null;
  }
  const tail = path.join(...opts.spec.split('/'));
  const daemon = path.normalize(opts.daemonPath);
  if (!daemon.toLowerCase().endsWith(tail.toLowerCase())) {
    return null;
  }
  const modulesDir = daemon.slice(0, daemon.length - tail.length).replace(/[\\/]+$/, '');
  return path.basename(modulesDir) === 'node_modules' ? { modulesDir } : null;
}

/**
 * Makes `<stageDir>/node_modules` lead to the folder that holds the bundle (a directory junction on Windows: no admin right). It
 * points at the modules folder, not at the bundle, so an update that replaces the package in place needs no new link.
 *
 * A real folder under that name is never touched. Removing the staged folder removes the link and not what it leads to.
 */
export function ensureBundleLink(stageDir: string, plan: { modulesDir: string }): 'created' | 'unchanged' | 'replaced' {
  const link = path.join(stageDir, 'node_modules');
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(link);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }
  if (existing !== null) {
    if (!existing.isSymbolicLink()) {
      throw new Error(
        `${link} is not a link: the launcher cannot find the daemon bundle through it. `
        + `It was left alone; delete it (it is inside orch's own staging folder), then run: orch install`,
      );
    }
    let current: string | null = null;
    try {
      current = fs.realpathSync(link);
    } catch {
      // A link to a folder that is gone.
    }
    if (current !== null && current === fs.realpathSync(plan.modulesDir)) {
      return 'unchanged';
    }
    // unlink on a junction removes the junction only.
    fs.unlinkSync(link);
    fs.symlinkSync(plan.modulesDir, link, 'junction');
    return 'replaced';
  }
  fs.symlinkSync(plan.modulesDir, link, 'junction');
  return 'created';
}
