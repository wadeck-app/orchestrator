// Kept out of entry.ts on purpose: that module runs the updater as a side effect of being
// imported, so a test importing it would launch a real upgrade. This one is pure.
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { getErrorMessage } from '../fsUtil.js';

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
      reason: `cannot read ${manifestPath}: ${getErrorMessage(e)}`,
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

/** Present in the failing command so a log line or a test can tell it from a real self-check. */
export const FAILING_SELF_CHECK_MARKER = 'orchestrator-self-check-unavailable';

export type SelfCheckArming = { command: string; note?: string; abort?: undefined } | { abort: string; command?: undefined; note?: undefined };

/**
 * Decides the command shared-updater runs after an install (or while repairing an interrupted one).
 *
 * Normally an unresolvable target aborts the run: shared-updater treats a missing command as "passed", so
 * going on would install an unverified upgrade with no rollback.
 *
 * With an 'applying' state journaled (an install was killed) the same condition is the expected one: the
 * package is half-removed. Aborting would stop shared-updater before its repair, leaving the CLI broken
 * until someone reinstalls by hand. The repair keeps the target only when the self-check passes, so
 * arming a command that fails makes it restore the previous version, which is the safe outcome.
 */
export function armSelfCheck(args: {
  nodeExe: string;
  resolved: { ok: true; target: string } | { ok: false; reason: string };
  interrupted: boolean;
}): SelfCheckArming {
  const { nodeExe, resolved, interrupted } = args;
  if (resolved.ok) {
    // execSync runs this through a shell, so both paths must be quoted. A default Windows install puts node under
    // violations-suppress: shared/no-out-of-repo-path prose naming the case this guards, not a path the code uses
    // "C:\Program Files\nodejs\", and an unquoted path is split at the space: the self-check then always fails and
    // every update gets rolled back.
    return { command: `"${nodeExe}" "${resolved.target}" cli self-check` };
  }
  if (interrupted) {
    return {
      command: `"${nodeExe}" -e "process.exit(1)" ${FAILING_SELF_CHECK_MARKER}`,
      note: `an interrupted install is journaled and the self-check cannot be armed (${resolved.reason}): the repair will restore the previous version`,
    };
  }
  return {
    abort: `${resolved.reason}. Without a usable entry point the post-install self-check cannot be armed, and an `
      + `unverified update would not be rollback-able. Repair with: npm install -g @wadeck-app/orchestrator-cli@latest`,
  };
}
