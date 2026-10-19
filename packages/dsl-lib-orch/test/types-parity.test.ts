import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_TYPES = path.resolve(here, '../src/types.ts');
const CLI_TYPES = path.resolve(here, '../../orchestrator-cli/src/types.ts');

/*
 * The UI keeps its own copy of the daemon's types (it cannot import orchestrator-cli). A field the daemon
 * records but the copy lacks reaches the browser and is silently ignored, so the two copies are compared
 * field by field. A field that is deliberately on one side only is listed here WITH its reason.
 */
const UI_ONLY: Record<string, Record<string, string>> = {
  Job: {},
  RuntimeEntry: {},
};
const CLI_ONLY: Record<string, Record<string, string>> = {
  Job: {},
  RuntimeEntry: {},
};

/** Top-level field names of `export interface <name>`, comments stripped. Throws when the interface is missing. */
function fieldsOf(file: string, name: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const start = text.search(new RegExp(`export interface ${name}(?![A-Za-z0-9_])`));
  if (start < 0) {
    throw new Error(`interface ${name} not found in ${file}`);
  }
  const open = text.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') {
      depth++;
    } else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) {
    throw new Error(`interface ${name} in ${file} is not closed`);
  }
  const fields: string[] = [];
  for (const line of text.slice(open + 1, end).split('\n')) {
    const m = /^ {2}(\w+)\??\s*:/.exec(line);
    if (m) {
      fields.push(m[1]);
    }
  }
  if (fields.length === 0) {
    throw new Error(`no field read from interface ${name} in ${file}: the parser is out of date`);
  }
  return fields;
}

describe.each(['Job', 'RuntimeEntry'])('%s: UI types.ts vs orchestrator-cli types.ts', (name) => {
  const ui = fieldsOf(UI_TYPES, name);
  const cli = fieldsOf(CLI_TYPES, name);

  it('has no CLI field missing from the UI copy', () => {
    const missing = cli.filter((f) => !ui.includes(f) && !(f in CLI_ONLY[name]));
    expect(missing, `${name}: fields the daemon has and the UI type lacks (add them, or list them in CLI_ONLY with a reason)`).toEqual([]);
  });

  it('has no UI field missing from the CLI type', () => {
    const extra = ui.filter((f) => !cli.includes(f) && !(f in UI_ONLY[name]));
    expect(extra, `${name}: fields only the UI declares (remove them, or list them in UI_ONLY with a reason)`).toEqual([]);
  });

  it('keeps no stale allow-list entry', () => {
    const stale = [
      ...Object.keys(CLI_ONLY[name]).filter((f) => ui.includes(f) || !cli.includes(f)),
      ...Object.keys(UI_ONLY[name]).filter((f) => cli.includes(f) || !ui.includes(f)),
    ];
    expect(stale).toEqual([]);
  });
});
