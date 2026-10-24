import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROGRESS_MODES, progressModeIds } from '../src/progress-modes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI_PROGRESS = path.resolve(here, '../../orchestrator-cli/src/progress');

/*
 * The form lists the progress modes with a sentence each. The daemon owns the list of strategy ids
 * (progress/registry.ts); the UI cannot import it, so the ids are read from the strategy sources.
 */
function registeredIds(): string[] {
  const files = fs.readdirSync(CLI_PROGRESS).filter(f => f.endsWith('-strategy.ts'));
  const ids: string[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(CLI_PROGRESS, f), 'utf8');
    // Only the exported strategy objects: `id: 'x',` at the start of a line. `auto-ensemble` style
    // instances share the id of the strategy they wrap.
    for (const m of text.matchAll(/^\s{2}id: '([a-z0-9-]+)',/gm)) {
      ids.push(m[1]!);
    }
    for (const m of text.matchAll(/\bid: '([a-z0-9-]+)',\s*\n\s*version:/g)) {
      ids.push(m[1]!);
    }
  }
  return [...new Set(ids)];
}

describe('progress modes of the job form', () => {
  it('offers auto, off and exactly the strategy ids the daemon registers', () => {
    const registered = registeredIds();
    expect(registered.length, 'could not read any strategy id from the daemon sources').toBeGreaterThan(0);
    expect([...progressModeIds()].sort()).toEqual(['auto', 'off', ...registered].sort());
  });

  it('gives every mode a one-line explanation', () => {
    for (const mode of PROGRESS_MODES) {
      expect(mode.explanation.trim(), mode.id).not.toBe('');
      expect(mode.explanation, mode.id).not.toContain('\n');
    }
  });

  it('gives a placeholder example only to the modes that take options, and it is valid JSON', () => {
    for (const mode of PROGRESS_MODES) {
      if (mode.optionsExample === undefined) {
        continue;
      }
      expect(() => JSON.parse(mode.optionsExample!), mode.id).not.toThrow();
    }
    expect(PROGRESS_MODES.find(m => m.id === 'ratio')?.optionsExample).toBeDefined();
    expect(PROGRESS_MODES.find(m => m.id === 'log-declared')?.optionsExample).toBeDefined();
    expect(PROGRESS_MODES.find(m => m.id === 'history')?.optionsExample).toBeUndefined();
    expect(PROGRESS_MODES.find(m => m.id === 'auto')?.optionsExample).toBeUndefined();
  });
});
