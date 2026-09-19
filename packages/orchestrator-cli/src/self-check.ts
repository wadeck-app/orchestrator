import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runSelfCheck: sharedRunSelfCheck } = require('@wadeck-app/shared-cli') as typeof import('@wadeck-app/shared-cli');

import { Registry }  from './registry.js';
import { State }     from './state.js';

export async function runSelfCheck(quiet = false): Promise<void> {
  await sharedRunSelfCheck(
    [
      // registry-class and state-class used to sit here, each asserting only that a class was a
      // function. Both are subsumed by registry-load and state-load below, which construct the
      // class and use it -- a missing or broken class cannot survive those. Keeping them inflated
      // the check count without adding a way to fail, which is worse than having fewer checks:
      // the updater's rollback gate is only as good as the weakest thing it accepts.
      //
      // Check: schedule-computation -- the cron maths behind `orch schedule`, the dashboard's next
      // firing column and the scheduler's own timers. scheduler-class, which this replaces, would
      // have passed with a cron library that returned nothing, a broken bundle, or a parse
      // regression; none of those are theoretical, since the whole daemon is a cron runner.
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getNextFirings } = require('./cronNext.js') as typeof import('./cronNext.js');
          // A weekly expression on purpose: a scan horizon too short to reach next week is how this
          // silently returned an empty list, leaving `orch schedule` and the dashboard blank for
          // every job sparser than daily. A frequent expression would pass with that bug present.
          const from = new Date('2026-01-01T00:00:00.000Z');
          const firings = getNextFirings('0 9 * * 1', 3, from);
          if (firings.length !== 3) {
            throw new Error(
              `expected 3 firings for the weekly "0 9 * * 1", got ${firings.length}: `
              + 'the scan horizon is too short to reach a sparse schedule',
            );
          }
          for (let i = 0; i < firings.length; i++) {
            if (Number.isNaN(firings[i]!.getTime())) {
              throw new Error(`firing ${i} is not a valid date`);
            }
            if (firings[i]!.getTime() <= from.getTime()) {
              throw new Error(`firing ${i} (${firings[i]!.toISOString()}) is not after ${from.toISOString()}`);
            }
            if (i > 0 && firings[i]!.getTime() <= firings[i - 1]!.getTime()) {
              throw new Error('firings are not strictly increasing, so the schedule would stall or repeat');
            }
          }
          return { name: 'schedule-computation', ok: true };
        } catch (err) {
          return { name: 'schedule-computation', ok: false, detail: (err as Error).message };
        }
      },
      // Check: registry-load -- create a temp registry and verify load() returns valid data
      async () => {
        try {
          const tmp = path.join(os.tmpdir(), `orch-selfcheck-reg-${Date.now()}.json`);
          const reg = new Registry(tmp);
          const data = reg.load();
          if (!Array.isArray(data.jobs)) {
            throw new Error('registry.load() returned invalid data');
          }
          try { fs.unlinkSync(tmp); } catch { /* ok */ }
          return { name: 'registry-load', ok: true };
        } catch (err) {
          return { name: 'registry-load', ok: false, detail: (err as Error).message };
        }
      },
      // Check: state-load -- create a temp state and verify getAll() returns an object
      async () => {
        try {
          const tmp = path.join(os.tmpdir(), `orch-selfcheck-state-${Date.now()}.json`);
          const s = new State(tmp);
          const all = s.getAll();
          if (typeof all !== 'object' || all === null) {
            throw new Error('state.getAll() returned non-object');
          }
          try { fs.unlinkSync(tmp); } catch { /* ok */ }
          return { name: 'state-load', ok: true };
        } catch (err) {
          return { name: 'state-load', ok: false, detail: (err as Error).message };
        }
      },
      // Check: server-binary -- verify orch-server is bundled inside this package
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { findOrchServerBinary } = require('./dashboard-binary.js') as typeof import('./dashboard-binary.js');
          const p = findOrchServerBinary();
          if (!p) {
            throw new Error('server binary path is empty');
          }
          return { name: 'server-binary', ok: true };
        } catch (err) {
          return { name: 'server-binary', ok: false, detail: (err as Error).message };
        }
      },
      // Check: native-binaries -- the Go launcher supervises the daemon and the tray is
      // spawned from the same platform package. npm skips optionalDependencies failures
      // silently, so without this check the updater's rollback gate would accept an install
      // whose platform package never landed, and the daemon could then never start again.
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { findLauncherBinary, findTrayBinary, platformPackage } =
            require('./platform-binary.js') as typeof import('./platform-binary.js');
          const pkg = platformPackage();
          if (pkg === null) {
            // No binaries are published for this target, so there is nothing to verify. Failing
            // here would make the updater roll back every upgrade on such a host, and CI runs
            // this suite on linux. Reported rather than passed over in silence.
            // The reason goes in the NAME, not in `detail`: runSelfCheck only prints `detail`
            // for a failure, so an ok result carrying its reason there would be an invisible
            // skip -- the pattern these checks exist to eliminate.
            return {
              name: `native-binaries (skipped: ${process.platform}-${process.arch} is not a published target)`,
              ok: true,
            };
          }
          if (!findLauncherBinary()) {
            throw new Error(`Go launcher not found; expected in ${pkg}`);
          }
          if (!findTrayBinary())     {
            throw new Error(`tray binary not found; expected in ${pkg}`);
          }
          return { name: 'native-binaries', ok: true };
        } catch (err) {
          return { name: 'native-binaries', ok: false, detail: (err as Error).message };
        }
      },
      // Check: version-consistency -- the version the running code believes must match the
      // installed package. esbuild inlines require('../package.json') at bundle time, so a
      // bundle built before the version was set reports the stale one forever: the daemon, the
      // CLI and the tray all announced 0.2.0 while the published package was 2026.9.15-246.
      // Nothing caught that, because every other check reads the same inlined copy.
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { version: inlined } = require('../package.json') as { version: string };
          const onDisk = (JSON.parse(
            fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'),
          ) as { version: string }).version;
          if (inlined !== onDisk) {
            throw new Error(
              `code reports ${inlined} but the installed package is ${onDisk}: `
              + 'the bundle was built before the version was set',
            );
          }
          return { name: 'version-consistency', ok: true };
        } catch (err) {
          return { name: 'version-consistency', ok: false, detail: (err as Error).message };
        }
      },
      // Check: entry-points -- everything package.json points at must exist on disk. Dropping a
      // path from `files`, or renaming an entry without updating the manifest, leaves `main` and
      // `bin` dangling: that is how dist/cli.js went missing while the updater kept invoking it,
      // which failed the self-check and rolled back every update.
      async () => {
        try {
          const root = path.join(__dirname, '..');
          // Only meaningful for an installed package. In a checkout, `main` points at a bundle
          // that only `npm run bundle` produces, and CI's build-and-test job deliberately does
          // not bundle, so requiring it there would fail every leg and block publishing.
          if (!root.split(path.sep).includes('node_modules')) {
            return { name: 'entry-points (skipped: build tree, not an installed package)', ok: true };
          }
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
            main?: string;
            bin?: string | Record<string, string>;
          };
          const targets: string[] = [];
          if (manifest.main) {
            targets.push(manifest.main);
          }
          if (typeof manifest.bin === 'string') {
            targets.push(manifest.bin);
          }
          else if (manifest.bin) {
            targets.push(...Object.values(manifest.bin));
          }

          const missing = [...new Set(targets)].filter((t) => !fs.existsSync(path.join(root, t)));
          if (missing.length > 0) {
            throw new Error(`package.json points at missing file(s): ${missing.join(', ')}`);
          }
          return { name: 'entry-points', ok: true };
        } catch (err) {
          return { name: 'entry-points', ok: false, detail: (err as Error).message };
        }
      },
      // Check: package-version -- verify package.json version is present
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { version } = require('../package.json') as { version: string };
          if (typeof version !== 'string' || !version) {
            throw new Error('package.json version missing');
          }
          return { name: 'package-version', ok: true };
        } catch (err) {
          return { name: 'package-version', ok: false, detail: (err as Error).message };
        }
      },
    ],
    // quiet=true passed from --quiet flag; env var CLI_SELF_CHECK_QUIET is handled by sharedRunSelfCheck itself
    quiet ? { quiet: true } : {},
  );
  // Always exit explicitly so callers (updater, tests) can rely on process.exit(0) for success.
  process.exit(0);
}
