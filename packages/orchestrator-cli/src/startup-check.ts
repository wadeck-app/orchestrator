import fs from 'node:fs';
import path from 'node:path';
import type { StartupResult } from './types.js';
import { getErrorMessage } from './fsUtil.js';
import { inspectStartupEntry, repairStartupEntry, type StartupEntryReport } from './startup.js';

export const STARTUP_CHECK_STAMP = 'startup-check.stamp';
const CHECK_EVERY_MS = 60 * 60_000;

export interface StartupCheckDeps {
  configDir: string;
  /** The command being run (the first word after `orch`). */
  command: string | undefined;
  /** A development build never rewrites the entry: it would register its own checkout. */
  releaseBuild: boolean;
  now: number;
  /** Seams for tests; production passes none. */
  inspect?: (configDir: string) => StartupEntryReport;
  repair?: (configDir: string) => { report: StartupEntryReport; repair: StartupResult | null };
  say?: (line: string) => void;
}

function checkedRecently(stamp: string, now: number): boolean {
  try {
    const at = Number(fs.readFileSync(stamp, 'utf8'));
    return Number.isFinite(at) && now - at >= 0 && now - at < CHECK_EVERY_MS;
  } catch {
    return false;
  }
}

/**
 * Every command checks that the registered start-at-login entry still resolves and re-registers it when it is broken: after a
 * node or npm prefix change the daemon would not start at the next login, with the reason only in a launcher log. Commands
 * come from cron jobs and agents under any node, so the entry is rewritten only when broken, never on a mere drift (two callers
 * under different nodes would rewrite it back and forth); a drift, and an absent entry, are said by `orch status` only. The
 * look happens at most once an hour, except for `orch status` and while the entry stays broken. Never throws.
 */
export function runStartupCheck(deps: StartupCheckDeps): void {
  const say = deps.say ?? ((line: string) => console.error(line));
  if (deps.command === 'install' || deps.command === 'uninstall') {
    return;
  }
  const verbose = deps.command === 'status';
  const stamp   = path.join(deps.configDir, STARTUP_CHECK_STAMP);
  try {
    if (!verbose && checkedRecently(stamp, deps.now)) {
      return;
    }
    const settle = (): void => { fs.writeFileSync(stamp, String(deps.now)); };
    let report: StartupEntryReport;
    let repair: StartupResult | null = null;
    if (deps.releaseBuild) {
      ({ report, repair } = (deps.repair ?? repairStartupEntry)(deps.configDir));
    } else {
      report = (deps.inspect ?? inspectStartupEntry)(deps.configDir);
    }

    if (report.state === 'broken') {
      const what = report.problems.join('; ');
      if (repair?.ok) {
        say(`Warning: the start-at-login entry was broken (${what}); it was re-registered with this install's paths.`);
        settle();
        return;
      }
      const why = repair ? `it could not be re-registered (${repair.ok ? '' : repair.error})` : 'this development build does not rewrite it';
      say(`Warning: the start-at-login entry is broken (${what}), so the daemon will not start at the next login: ${why}. Run \`orch install\` from the install you use.`);
      return;
    }
    if (verbose && report.state === 'drift') {
      say(`Warning: the start-at-login entry works but starts another install than this one (${report.problems.join('; ')}). Run \`orch install\` to point it at this one.`);
    }
    if (verbose && report.state === 'absent') {
      say('Warning: start-at-login is not registered for this config dir: the daemon will not start after a reboot. Run `orch install`.');
    }
    settle();
  } catch (e) {
    say(`Warning: the start-at-login check failed: ${getErrorMessage(e)}`);
  }
}
