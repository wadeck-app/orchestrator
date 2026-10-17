import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDslLib } from '../scripts/build.js';
import { OUT_DIR_VAR } from './out-dir.js';

/**
 * Builds the bundle once, in plain Node. esbuild refuses to run inside the jsdom environment the
 * rendering tests need ("TextEncoder().encode('') instanceof Uint8Array is incorrectly false"), so
 * the build cannot live in those tests; they read the output directory from OUT_DIR_VAR.
 */

let outDir: string | undefined;

export async function setup(): Promise<void> {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dsl-lib-'));
  await buildDslLib({ outDir });
  process.env[OUT_DIR_VAR] = outDir;
}

export function teardown(): void {
  if (outDir !== undefined) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
