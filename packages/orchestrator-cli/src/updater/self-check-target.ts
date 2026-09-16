// Kept out of entry.ts on purpose: that module runs the updater as a side effect of being
// imported, so a test importing it would launch a real upgrade. This one is pure.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/**
 * Locates the CLI entry point that the post-install self-check will run.
 *
 * The command is built before the upgrade but runs after it, so it must name a path the future
 * package still has. Targeting an internal bundle makes any later rename a one-way trap for every
 * client already in the field: the old updater keeps invoking the old path, the self-check fails,
 * shared-updater rolls back, and the fix can only ship inside the package the old updater just
 * refused. That already happened -- versions before b8514e8 pointed at dist/cli.js, which `files`
 * never published, so every update rolled back and those installs need a manual reinstall.
 *
 * `bin` is the package's published contract and bin/orch.js resolves the bundle itself at runtime,
 * so it survives renames of anything under dist/. Existence is verified rather than assumed,
 * because arming a doomed command is what made that failure silent and permanent.
 */
export function resolveSelfCheckTarget(
  npmRoot: string,
  pkgName: string,
): { ok: true; target: string } | { ok: false; reason: string } {
  const pkgDir = join(npmRoot, pkgName);
  const manifestPath = join(pkgDir, 'package.json');
  let binRel: string | undefined;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      bin?: Record<string, string>;
    };
    binRel = manifest.bin?.['orch'];
  } catch (e) {
    return {
      ok: false,
      reason: `cannot read ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (binRel === undefined) {
    return { ok: false, reason: `${manifestPath} declares no bin.orch entry` };
  }
  const target = join(pkgDir, binRel);
  if (!existsSync(target)) {
    return { ok: false, reason: `bin.orch points at ${target}, which does not exist` };
  }
  return { ok: true, target };
}
