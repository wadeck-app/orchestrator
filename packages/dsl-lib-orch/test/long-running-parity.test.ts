import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLongRunning as uiIsLongRunning } from '../src/long-running.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_SRC = path.resolve(here, '../src');
const CLI_SRC = path.resolve(here, '../../orchestrator-cli/src');
const CLI_HELPER = path.join(CLI_SRC, 'long-running.ts');

/*
 * "Long-running" (a job declared with no timeout, `timeoutSeconds: 0`) decides two behaviours: the tray shows
 * such a job as running for a few seconds only (orchestrator-cli), and the dashboard offers Restart only for it
 * (dsl-lib-orch). The UI cannot import the CLI (build chain), so each side has ONE helper named isLongRunning
 * in long-running.ts. If they diverge, the tray and the dashboard disagree on what a server job is.
 */
const CASES: Array<[string, { timeoutSeconds?: number }]> = [
  ['no timeout declared (the default is 300 s)', {}],
  ['timeoutSeconds 0', { timeoutSeconds: 0 }],
  ['timeoutSeconds 1', { timeoutSeconds: 1 }],
  ['timeoutSeconds 300', { timeoutSeconds: 300 }],
  ['timeoutSeconds NaN', { timeoutSeconds: Number.NaN }],
  ['timeoutSeconds negative', { timeoutSeconds: -1 }],
];

/** Non-test source files under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'generated' ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

describe('isLongRunning: dsl-lib-orch vs orchestrator-cli', () => {
  it('answers the same on both sides, for every shape of timeout', async () => {
    const cli = await import(/* @vite-ignore */ pathToFileURL(CLI_HELPER).href) as { isLongRunning: (job: { timeoutSeconds?: number }) => boolean };
    for (const [label, job] of CASES) {
      expect(uiIsLongRunning(job), label).toBe(cli.isLongRunning(job));
    }
  });

  it('is true for timeoutSeconds 0 only', () => {
    expect(CASES.filter(([, job]) => uiIsLongRunning(job)).map(([label]) => label)).toEqual(['timeoutSeconds 0']);
  });

  it('each helper points at the other in its doc comment', () => {
    expect(fs.readFileSync(CLI_HELPER, 'utf8')).toContain('dsl-lib-orch/src/long-running.ts');
    expect(fs.readFileSync(path.join(UI_SRC, 'long-running.ts'), 'utf8')).toContain('orchestrator-cli/src/long-running.ts');
  });

  // The definition lives in long-running.ts and nowhere else, so a new `timeoutSeconds === 0` somewhere is
  // a second definition that this test cannot compare.
  it.each([['dsl-lib-orch', UI_SRC], ['orchestrator-cli', CLI_SRC]])('%s: no second definition of long-running outside long-running.ts', (_name, dir) => {
    const offenders = sourceFiles(dir)
      .filter((file) => path.basename(file) !== 'long-running.ts')
      .filter((file) => /timeoutSeconds\s*[!=]==?\s*0\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(dir, file));
    expect(offenders, 'use isLongRunning from long-running.ts instead of testing timeoutSeconds against 0').toEqual([]);
  });
});
