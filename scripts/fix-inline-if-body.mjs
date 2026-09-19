// Put braces on inline if/else bodies, for ts/no-inline-if-body.
//
// Parses, rather than pattern-matching. The shapes in this repo include `if (x) return;`,
// `if (x) foo(); else bar();`, multi-line conditions, else-if chains, and bodies containing `;`
// inside string literals -- a regex gets some of those wrong silently, which is the one outcome
// worth avoiding when rewriting 362 sites.
//
// Uses @babel/parser and NOT typescript, because this repo is on typescript 7.0.2 -- the native
// port -- whose JS entry point exports only `version` and `versionMajorMinor`. There is no
// createSourceFile to call. @babel/parser is present as a transitive dependency (via vite's react
// plugin) rather than a declared one, which is acceptable for a one-off codemod and would not be for
// anything shipped or run in CI.
//
// Anything it is not confident about is REPORTED, never skipped quietly.
//
// Usage: node scripts/fix-inline-if-body.mjs [--check] <file> [<file>...]
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const files = (checkOnly ? args.slice(1) : args).filter(Boolean);

if (files.length === 0) {
  console.error('usage: fix-inline-if-body.mjs [--check] <file> [<file>...]');
  process.exit(2);
}

function pluginsFor(file) {
  const ext = path.extname(file);
  // The jsx plugin is only added where angle brackets cannot be a type assertion: in a .ts file
  // `<Foo>bar` is a cast, and enabling jsx there makes it a parse error.
  if (ext === '.tsx') return ['typescript', 'jsx'];
  if (ext === '.ts') return ['typescript'];
  return ['jsx'];
}

/** The whitespace prefix of the line `pos` sits on, so the inserted brace lines up with the `if`. */
function indentOf(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  const match = text.slice(lineStart, pos).match(/^[ \t]*/);
  return match ? match[0] : '';
}

function lineOf(text, pos) {
  return text.slice(0, pos).split('\n').length;
}

/** Every IfStatement in the tree, found without a visitor library. */
function collectIfStatements(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) collectIfStatements(item, out);
    return out;
  }
  if (typeof node.type === 'string') {
    if (node.type === 'IfStatement') out.push(node);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
    collectIfStatements(node[key], out);
  }
  return out;
}

let totalEdits = 0;
let filesChanged = 0;
const skipped = [];
let failures = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');

  let ast;
  try {
    ast = parse(text, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      plugins: pluginsFor(file),
    });
  } catch (err) {
    // Loud: a file this cannot parse must not be reported as clean.
    console.error(`  PARSE FAILED  ${file}: ${err.message}`);
    failures++;
    continue;
  }

  const edits = [];
  for (const node of collectIfStatements(ast.program)) {
    if (node.consequent && node.consequent.type !== 'BlockStatement') {
      edits.push({ stmt: node.consequent, anchor: node.start });
    }
    // `else if (...)` is an IfStatement and is idiomatic unbraced -- leave those alone. Any other
    // unbraced else body gets braces.
    if (node.alternate
      && node.alternate.type !== 'BlockStatement'
      && node.alternate.type !== 'IfStatement') {
      edits.push({ stmt: node.alternate, anchor: node.alternate.start });
    }
  }

  if (edits.length === 0) {
    console.log(`  unchanged  ${file}`);
    continue;
  }

  // Applied last-first so earlier offsets stay valid.
  edits.sort((a, b) => b.stmt.start - a.stmt.start);

  let out = text;
  let applied = 0;
  for (const { stmt, anchor } of edits) {
    const body = text.slice(stmt.start, stmt.end);

    // A body already spanning lines is left for a human: re-indenting it correctly is beyond what
    // this is for, and a mangled multi-line body is worse than a violation.
    if (body.includes('\n')) {
      skipped.push(`${file}:${lineOf(text, stmt.start)} multi-line body`);
      continue;
    }

    const indent = indentOf(text, anchor);
    out = `${out.slice(0, stmt.start)}{\n${indent}  ${body}\n${indent}}${out.slice(stmt.end)}`;
    applied++;
  }

  if (applied === 0) {
    console.log(`  unchanged  ${file}  (${edits.length} site(s) all skipped)`);
    continue;
  }
  totalEdits += applied;
  filesChanged++;
  console.log(`  ${checkOnly ? 'would fix' : 'fixed'}   ${file}  ${applied} site(s)`);
  if (!checkOnly) writeFileSync(file, out);
}

console.log(`\n${checkOnly ? 'would change' : 'changed'} ${totalEdits} site(s) in ${filesChanged} file(s)`);
if (skipped.length > 0) {
  console.log(`\n${skipped.length} site(s) left for a human:`);
  for (const s of skipped) console.log(`  ${s}`);
}
if (failures > 0) {
  console.error(`\n${failures} file(s) could not be parsed`);
  process.exit(1);
}
