import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_TYPES = path.resolve(here, '../src/types.ts');
const CLI_SRC = path.resolve(here, '../../orchestrator-cli/src');
const CLI_TYPES = path.join(CLI_SRC, 'types.ts');

/*
 * The UI keeps its own copy of the daemon's types (it cannot import orchestrator-cli). A field the daemon
 * records but the copy lacks reaches the browser and is silently ignored, so the two copies are compared
 * field by field. A field that is deliberately on one side only is listed here WITH its reason.
 */
const UI_ONLY: Record<string, Record<string, string>> = {
  Job: {},
  RuntimeEntry: {},
  RestartResult: {},
  ResourceLimits: {},
  ResourceHistory: {},
  ResourceHistoryRun: {},
  ProgressEstimate: {},
};
const CLI_ONLY: Record<string, Record<string, string>> = {
  Job: {},
  RuntimeEntry: {},
  RestartResult: {},
  ResourceLimits: {},
  ResourceHistory: {},
  ResourceHistoryRun: {},
  ProgressEstimate: {},
};

/*
 * Where the daemon declares each interface, and under which name when it differs from the UI's. The resource
 * history is read from disk by resource-history.ts, which is why it is not in types.ts like the rest.
 */
const CLI_DECL: Record<string, { file: string; name: string }> = {
  Job: { file: CLI_TYPES, name: 'Job' },
  RuntimeEntry: { file: CLI_TYPES, name: 'RuntimeEntry' },
  RestartResult: { file: CLI_TYPES, name: 'RestartResult' },
  ResourceLimits: { file: CLI_TYPES, name: 'ResourceLimits' },
  ResourceHistory: { file: path.join(CLI_SRC, 'resource-history.ts'), name: 'ResourceHistory' },
  ResourceHistoryRun: { file: path.join(CLI_SRC, 'resource-history.ts'), name: 'ResourceHistoryRecord' },
  ProgressEstimate: { file: path.join(CLI_SRC, 'progress', 'types.ts'), name: 'ProgressEstimate' },
};

/** Top-level field names of `export interface <name>`, comments stripped. Throws when the interface is missing. */
function fieldsOf(file: string, name: string): string[] {
  const text = fs.readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
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

/** The text of `export type <name> = ...;`, comments and whitespace removed. Throws when it is missing. */
function typeAliasOf(file: string, name: string): string {
  // A checkout with CRLF line endings (the CI's Windows runner) must read like one with LF.
  const text = fs.readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const m = new RegExp(`export type ${name}\\s*=([\\s\\S]*?);[ \\t]*(?:\\n|$)`).exec(text);
  if (!m) {
    throw new Error(`type ${name} not found in ${file}`);
  }
  return m[1].replace(/\s+/g, ' ').trim();
}

describe('JobProgressSetting: UI types.ts vs the daemon declaration', () => {
  it('is declared identically on both sides', () => {
    expect(typeAliasOf(UI_TYPES, 'JobProgressSetting')).toBe(typeAliasOf(CLI_TYPES, 'JobProgressSetting'));
  });
});

describe('UnsettableJobField: the UI list covers the daemon UNSETTABLE_FIELDS keys that the UI can send', () => {
  it('includes progress', () => {
    expect(typeAliasOf(UI_TYPES, 'UnsettableJobField')).toContain("'progress'");
  });
});

describe.each(Object.keys(CLI_DECL))('%s: UI types.ts vs the daemon declaration', (name) => {
  const ui = fieldsOf(UI_TYPES, name);
  const cli = fieldsOf(CLI_DECL[name].file, CLI_DECL[name].name);

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

// The CI's Windows runner checks files out with CRLF line endings: the alias reader looked for ';' followed by '\n' and
// found neither type ('type JobProgressSetting not found'), while the same test passed on a machine with LF files.
describe('typeAliasOf on a file with CRLF line endings', () => {
  it('reads a multi-line alias exactly as it reads the LF one', () => {
    const lf = "export type Mode =\n  | 'a'\n  | 'b';\nexport type Other = 'x';\n";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-parity-crlf-'));
    try {
      const lfFile = path.join(dir, 'lf.ts');
      const crlfFile = path.join(dir, 'crlf.ts');
      fs.writeFileSync(lfFile, lf);
      fs.writeFileSync(crlfFile, lf.replace(/\n/g, '\r\n'));
      expect(typeAliasOf(crlfFile, 'Mode')).toBe(typeAliasOf(lfFile, 'Mode'));
      expect(typeAliasOf(crlfFile, 'Mode')).toBe("| 'a' | 'b'");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
