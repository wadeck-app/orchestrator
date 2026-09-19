// Replace typographic decorators with plain ASCII, for shared/no-em-dash.
//
// Deliberately takes an explicit file list rather than walking the repo: the rule fires on prose and
// on user-facing strings alike, and a blind sweep would also rewrite files nobody asked about.
//
// Usage: node scripts/fix-typographic-chars.mjs <file> [<file>...]
//        node scripts/fix-typographic-chars.mjs --check <file> [...]   -- report only, change nothing
import { readFileSync, writeFileSync } from 'node:fs';

// Ordered, and each is a single code point. `--` for an em-dash matches what this repo already writes
// in prose; an en-dash becomes a single hyphen because it is used for ranges.
const REPLACEMENTS = [
  ['—', '--'],  // — em dash
  ['–', '-'],   // – en dash
  ['―', '--'],  // ― horizontal bar
  ['•', '-'],   // • bullet
  ['·', '-'],   // · middle dot
  ['…', '...'], // … ellipsis
  ['«', '"'],   // « left angle quote
  ['»', '"'],   // » right angle quote
  ['‘', "'"],   // ' left single quote
  ['’', "'"],   // ' right single quote
  ['“', '"'],   // " left double quote
  ['”', '"'],   // " right double quote
  // Symbols, for shared/no-emoji. Only the ones with an unambiguous ASCII reading: an arrow always
  // means "becomes", a multiplication sign always means times. Status glyphs are deliberately NOT
  // here -- a tick is `[ok]` in terminal output and an icon component in the UI, and only whoever
  // owns the string knows which.
  ['→', '->'],  // rightwards arrow
  ['←', '<-'],  // leftwards arrow
  ['↑', '^'],   // upwards arrow
  ['↓', 'v'],   // downwards arrow
  ['×', 'x'],   // multiplication sign
];

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check';
const files = checkOnly ? args.slice(1) : args;

if (files.length === 0) {
  console.error('usage: fix-typographic-chars.mjs [--check] <file> [<file>...]');
  process.exit(2);
}

let totalChanged = 0;
let filesChanged = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    // Loudly: a typo in a path must not look like a clean file.
    console.error(`could not read ${file}: ${err.message}`);
    process.exit(1);
  }

  let out = text;
  const hits = [];
  let changed = 0;
  for (const [from, to] of REPLACEMENTS) {
    // Counted on the running text, before this replacement is applied, so the tally matches what
    // this pass actually did. split/join rather than a regex: `from` is a literal code point.
    const count = out.split(from).length - 1;
    if (count === 0) {
      continue;
    }
    out = out.split(from).join(to);
    changed += count;
    hits.push(`${count}x ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }

  if (out === text) {
    console.log(`  unchanged  ${file}`);
    continue;
  }
  filesChanged++;
  totalChanged += changed;
  console.log(`  ${checkOnly ? 'would fix' : 'fixed'}   ${file}  (${hits.join(', ')})`);
  if (!checkOnly) writeFileSync(file, out);
}

console.log(`\n${checkOnly ? 'would change' : 'changed'} ${totalChanged} character(s) in ${filesChanged} file(s)`);
