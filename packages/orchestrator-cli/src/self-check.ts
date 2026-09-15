import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runSelfCheck: sharedRunSelfCheck } = require('@wadeck-app/shared-cli') as typeof import('@wadeck-app/shared-cli');

import { Registry }  from './registry.js';
import { State }     from './state.js';
import { Scheduler } from './scheduler.js';

export async function runSelfCheck(quiet = false): Promise<void> {
  await sharedRunSelfCheck(
    [
      // Check: registry-class -- verify Registry class is loaded
      async () => {
        try {
          if (typeof Registry !== 'function') throw new Error('Registry class not loaded');
          return { name: 'registry-class', ok: true };
        } catch (err) {
          return { name: 'registry-class', ok: false, detail: (err as Error).message };
        }
      },
      // Check: registry-load -- create a temp registry and verify load() returns valid data
      async () => {
        try {
          const tmp = path.join(os.tmpdir(), `orch-selfcheck-reg-${Date.now()}.json`);
          const reg = new Registry(tmp);
          const data = reg.load();
          if (!Array.isArray(data.jobs)) throw new Error('registry.load() returned invalid data');
          try { fs.unlinkSync(tmp); } catch { /* ok */ }
          return { name: 'registry-load', ok: true };
        } catch (err) {
          return { name: 'registry-load', ok: false, detail: (err as Error).message };
        }
      },
      // Check: state-class -- verify State class is loaded
      async () => {
        try {
          if (typeof State !== 'function') throw new Error('State class not loaded');
          return { name: 'state-class', ok: true };
        } catch (err) {
          return { name: 'state-class', ok: false, detail: (err as Error).message };
        }
      },
      // Check: state-load -- create a temp state and verify getAll() returns an object
      async () => {
        try {
          const tmp = path.join(os.tmpdir(), `orch-selfcheck-state-${Date.now()}.json`);
          const s = new State(tmp);
          const all = s.getAll();
          if (typeof all !== 'object' || all === null) throw new Error('state.getAll() returned non-object');
          try { fs.unlinkSync(tmp); } catch { /* ok */ }
          return { name: 'state-load', ok: true };
        } catch (err) {
          return { name: 'state-load', ok: false, detail: (err as Error).message };
        }
      },
      // Check: scheduler-class -- verify Scheduler class is loaded
      async () => {
        try {
          if (typeof Scheduler !== 'function') throw new Error('Scheduler class not loaded');
          return { name: 'scheduler-class', ok: true };
        } catch (err) {
          return { name: 'scheduler-class', ok: false, detail: (err as Error).message };
        }
      },
      // Check: server-binary -- verify orch-server is bundled inside this package
      async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { findOrchServerBinary } = require('./dashboard-binary.js') as typeof import('./dashboard-binary.js');
          const p = findOrchServerBinary();
          if (!p) throw new Error('server binary path is empty');
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
            return {
              name: 'native-binaries',
              ok: true,
              detail: `skipped: ${process.platform}-${process.arch} is not a published target`,
            };
          }
          if (!findLauncherBinary()) throw new Error(`Go launcher not found; expected in ${pkg}`);
          if (!findTrayBinary())     throw new Error(`tray binary not found; expected in ${pkg}`);
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
          const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
            main?: string;
            bin?: string | Record<string, string>;
          };
          const targets: string[] = [];
          if (manifest.main) targets.push(manifest.main);
          if (typeof manifest.bin === 'string') targets.push(manifest.bin);
          else if (manifest.bin) targets.push(...Object.values(manifest.bin));

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
          if (typeof version !== 'string' || !version) throw new Error('package.json version missing');
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
