import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { stripEscapeSequences } from '../src/strip-ansi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(here, '../../orchestrator-cli/src');
const require = createRequire(import.meta.url);

/*
 * The dashboard log pane and the CLI (views, run log files) both strip the colour and cursor sequences a job
 * printed. The UI cannot import the CLI (build chain), so each side owns a helper; this test runs both over
 * the table the CLI keeps in orchestrator-cli/test/ansi-cases.js and fails if they ever disagree.
 */
const { ANSI_CASES } = require('../../orchestrator-cli/test/ansi-cases.js') as {
  ANSI_CASES: Array<[string, string, string]>;
};

describe('strip-ansi parity with the CLI helper', () => {
  it('the table is not empty', () => {
    expect(ANSI_CASES.length).toBeGreaterThan(10);
  });

  it.each(ANSI_CASES)('dashboard: %s', (_what, input, expected) => {
    expect(stripEscapeSequences(input)).toBe(expected);
  });

  it('the CLI helper exists where the dashboard one points', () => {
    expect(fs.existsSync(path.join(CLI_SRC, 'ansi.ts'))).toBe(true);
    expect(fs.readFileSync(path.join(here, '../src/strip-ansi.ts'), 'utf8')).toContain('orchestrator-cli/src/ansi.ts');
  });
});
