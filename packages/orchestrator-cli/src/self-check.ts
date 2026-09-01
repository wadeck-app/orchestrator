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
