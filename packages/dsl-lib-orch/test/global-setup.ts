import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { buildCss } from '../scripts/build-css.js';
import { OUT_DIR_VAR } from './out-dir.js';
import { MODULE_DIR } from '../src/paths.js';

/**
 * Packages the module once, in plain Node, exactly as CI does: the stylesheet first, then
 * `app-core-cli package`. The tests read the output directory from OUT_DIR_VAR.
 *
 * Not inside the tests: they run in jsdom, where esbuild (which the CLI runs) refuses to start
 * ("TextEncoder().encode('') instanceof Uint8Array is incorrectly false").
 */

/** Overrides where the CLI is looked for: a path to its cli.bundle.js (a checkout of app-core, say). */
const CLI_VAR = 'ORCH_APP_CORE_CLI';

let outDir: string | undefined;

function findCli(): string {
  const override = process.env[CLI_VAR];
  if (override !== undefined && override !== '') {
    if (!fs.existsSync(override)) {
      throw new Error(`${CLI_VAR}=${override} does not exist. Point it at an app-core-cli cli.bundle.js, or unset it to use the one in node_modules.`);
    }
    return override;
  }
  try {
    const pkg = createRequire(import.meta.url).resolve('@wadeck-app/app-core-cli/package.json');
    return path.join(path.dirname(pkg), 'dist', 'cli.bundle.js');
  } catch {
    throw new Error(`@wadeck-app/app-core-cli is not installed, so the module cannot be packaged for the tests. Run "npm install" at the repository root, or set ${CLI_VAR} to the cli.bundle.js of an app-core checkout.`);
  }
}

export async function setup(): Promise<void> {
  const cli = findCli();
  await buildCss();
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-module-'));
  const run = spawnSync(process.execPath, [cli, 'package', MODULE_DIR, '--out', outDir, '--version', '0.0.0-test'], { encoding: 'utf8', windowsHide: true });
  if (run.status !== 0) {
    throw new Error(`app-core-cli package failed (exit ${String(run.status)}) for ${MODULE_DIR}:\n${run.stdout}${run.stderr}${run.error?.message ?? ''}`);
  }
  process.env[OUT_DIR_VAR] = outDir;
}

export function teardown(): void {
  if (outDir !== undefined) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
