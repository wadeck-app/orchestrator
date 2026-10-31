import fs from 'node:fs';
import path from 'node:path';

/** The bundle the Go launcher is built to find (ci/launcher.config.json, checked by a test). */
export const LAUNCHER_BUNDLE_SPEC = '@wadeck-app/orchestrator-cli/dist/orchestrator.cjs';

/**
 * LAUNCHER_BUNDLE_OVERRIDE to hand the launcher, or undefined for none.
 *
 * An override is fixed for the launcher's whole life. After `nvm use` it kept starting the previous node's bundle while the
 * updater installed into the new one: 822 daemon restarts in a day. When the launcher finds this very bundle by itself each time
 * it starts the daemon (<dirname of the node on PATH>/node_modules/<spec>, which on nvm for Windows is a junction that follows `nvm use`),
 * nothing is fixed. Any other bundle (a checkout, a unix global prefix, which keeps its modules in lib/) stays fixed.
 */
export function launcherBundleOverride(opts: {
  daemonPath: string;
  spec: string;
  nodeDir: string | null;
  realpath?: (p: string) => string;
}): string | undefined {
  if (opts.nodeDir === null) {
    return opts.daemonPath;
  }
  const realpath = opts.realpath ?? fs.realpathSync;
  const found = path.join(opts.nodeDir, 'node_modules', ...opts.spec.split('/'));
  try {
    return realpath(found) === realpath(opts.daemonPath) ? undefined : opts.daemonPath;
  } catch {
    // The launcher's own lookup (a stat) fails the same way: it would not find the bundle, so it must be told.
    return opts.daemonPath;
  }
}

/** The directory of the node the launcher will find: the first PATH entry holding node, as exec.LookPath does. */
export function nodeDirOnPath(env: NodeJS.ProcessEnv): string | null {
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH');
  const value = key === undefined ? undefined : env[key];
  if (!value) {
    return null;
  }
  const exe = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of value.split(path.delimiter)) {
    if (dir !== '' && fs.existsSync(path.join(dir, exe))) {
      return dir;
    }
  }
  return null;
}
