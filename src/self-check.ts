import path from 'node:path';
import os   from 'node:os';
import fs   from 'node:fs';

import { Registry }  from './registry.js';
import { State }     from './state.js';
import { Scheduler } from './scheduler.js';

interface Check { name: string; fn: () => unknown; }

export async function runSelfCheck(quiet = false): Promise<void> {
  const checks: Check[] = [
    {
      name: 'registry-class',
      fn: () => {
        if (typeof Registry !== 'function') throw new Error('Registry class not loaded');
      },
    },
    {
      name: 'registry-load',
      fn: () => {
        const tmp = path.join(os.tmpdir(), `orch-selfcheck-reg-${Date.now()}.json`);
        const reg = new Registry(tmp);
        const data = reg.load();
        if (!Array.isArray(data.jobs)) throw new Error('registry.load() returned invalid data');
        try { fs.unlinkSync(tmp); } catch { /* ok */ }
      },
    },
    {
      name: 'state-class',
      fn: () => {
        if (typeof State !== 'function') throw new Error('State class not loaded');
      },
    },
    {
      name: 'state-load',
      fn: () => {
        const tmp = path.join(os.tmpdir(), `orch-selfcheck-state-${Date.now()}.json`);
        const s = new State(tmp);
        const all = s.getAll();
        if (typeof all !== 'object' || all === null) throw new Error('state.getAll() returned non-object');
        try { fs.unlinkSync(tmp); } catch { /* ok */ }
      },
    },
    {
      name: 'scheduler-class',
      fn: () => {
        if (typeof Scheduler !== 'function') throw new Error('Scheduler class not loaded');
      },
    },
    {
      name: 'package-version',
      fn: () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { version } = require('../package.json') as { version: string };
        if (typeof version !== 'string' || !version) throw new Error('package.json version missing');
      },
    },
  ];

  let passed = 0;
  let failed = 0;
  for (const check of checks) {
    try {
      await check.fn();
      if (!quiet) console.error(`  ✓ ${check.name}`);
      passed++;
    } catch (e) {
      if (!quiet) console.error(`  ✗ ${check.name}: ${(e as Error).message}`);
      failed++;
    }
  }

  if (!quiet) console.error(`\nself-check: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
